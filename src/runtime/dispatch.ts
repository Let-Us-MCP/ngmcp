import {
  PROTOCOL_VERSION, UI_EXTENSION, APP_MIME, META,
} from "../protocol/version.js";
import { CODE, RpcError } from "../protocol/errors.js";
import { parseMeta, requireCapabilities } from "../protocol/meta.js";
import type {
  Failure, Id, Incoming, Notification, Response, Success,
} from "../protocol/jsonrpc.js";
import { isRequest } from "../protocol/jsonrpc.js";
import {
  Limiter, RequestLifetime, systemClock, type Clock,
} from "./concurrency.js";
import { InFlight, RequestNotifier, type Backpressure, type Sink } from "./notifications.js";
import {
  InputRequired, inputRequiredResult, inputResponsesOf, requestStateOf,
  type InputRequests, type InputResponses,
} from "./mrtr.js";
import {
  Subscriptions, agreed, SUBSCRIPTION_ID,
  type SubscriptionFilter,
} from "./subscriptions.js";
import {
  toolDescriptor, promptDescriptor, validate, viewContents,
  type Context, type RegisteredPrompt,
  type RegisteredTool, type ResourceDefinition, type ViewDefinition,
} from "./registry.js";

export interface DispatcherOptions {
  name: string;
  version: string;
  instructions?: string;
  tools: Map<string, RegisteredTool>;
  views: Map<string, ViewDefinition>;
  resources: Map<string, ResourceDefinition>;
  prompts?: Map<string, RegisteredPrompt>;
  /** Zero means unbounded, which statelessness makes a reasonable default. */
  concurrency?: number;
  defaultTimeoutMs?: number;
  clock?: Clock;
  backpressure?: Backpressure;
}

/** Raised when a request dies while queued, so it never reaches its handler. */
class AbortedBeforeStart extends Error {}

/* Identity matters: a dispatcher with this sink still attached is one no
 * transport has wired up, which is how `subscriptions/listen` can tell that
 * there is nowhere for a stream to go. */
const NO_SINK: Sink = () => {};

const ok = (id: Id, result: Record<string, unknown>): Success =>
  ({ jsonrpc: "2.0", id, result });

const err = (id: Id | null, code: number, message: string, data?: unknown): Failure =>
  ({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } });

/** Answers requests. Holds no per-connection state, by construction.
 *
 * Everything a request needs arrives with the request. The only state on this
 * object is the registry, which is fixed at construction, and the set of
 * in-flight lifetimes, which exists so a cancellation can find its request.
 * Nothing here varies per client, which is what lets the same instance serve
 * stdio, HTTP and a serverless invocation without changing behaviour.
 */
export class Dispatcher {
  readonly #limiter: Limiter;
  readonly inFlight = new InFlight();
  /** Open `subscriptions/listen` streams, which are in-flight requests too. */
  readonly subscriptions = new Subscriptions();
  #sink: Sink = NO_SINK;
  #backpressure: Backpressure | undefined;

  constructor(private readonly options: DispatcherOptions) {
    this.#limiter = new Limiter(options.concurrency ?? 0);
    this.#backpressure = options.backpressure;
  }

  /** Where notifications go. Set by the transport. */
  set sink(sink: Sink) { this.#sink = sink; }

  /** How full the transport is. A transport sets this when it attaches, since
   *  it does not exist yet when the dispatcher is built. Without it every
   *  notification queues, which is the difference between a mechanism that
   *  exists and one that runs. */
  set backpressure(backpressure: Backpressure) { this.#backpressure = backpressure; }

  get #prompts(): Map<string, RegisteredPrompt> {
    return this.options.prompts ?? new Map();
  }

  get capabilities(): Record<string, unknown> {
    return {
      // `listChanged: true` is what makes the matching `subscriptions/listen`
      // filter honourable, so it is declared for what this server can actually
      // tell a client about and withheld for what it cannot.
      tools: { listChanged: true },
      resources: { listChanged: true },
      ...(this.#prompts.size ? { prompts: { listChanged: true } } : {}),
      extensions: {
        [UI_EXTENSION]: { mimeTypes: [APP_MIME] },
      },
    };
  }

  /** Tell every subscription that asked. Nothing reaches a client that did not.
   *
   * Returns how many notifications went out, which is per subscription rather
   * than per client: the tag differs, and a client uses it to work out which of
   * its streams a message belongs to. */
  notify(method: string, params: Record<string, unknown> = {}): number {
    const notes = this.subscriptions.match(method, params);
    for (const note of notes) this.#sink(note);
    return notes.length;
  }

  /** A resource changed. Only the clients watching that uri hear about it. */
  resourceUpdated(uri: string): number {
    return this.notify("notifications/resources/updated", { uri });
  }

  /** Handle one incoming message. Returns null for notifications. */
  async handle(message: Incoming): Promise<Response | null> {
    if (!isRequest(message)) {
      this.#handleNotification(message as Notification);
      return null;
    }
    const { id, method, params } = message;
    try {
      const meta = parseMeta(method, params);
      return await this.#route(id, method, params ?? {}, meta);
    } catch (error) {
      if (error instanceof RpcError) {
        return err(id, error.code, error.message, error.data);
      }
      return err(id, CODE.internal, (error as Error).message ?? "Internal error");
    }
  }

  #handleNotification(message: Notification): void {
    if (message.method === "notifications/cancelled") {
      const target = (message.params as { requestId?: Id } | undefined)?.requestId;
      if (target !== undefined) this.inFlight.cancel(target);
    }
  }

  async #route(
    id: Id,
    method: string,
    params: Record<string, unknown>,
    meta: ReturnType<typeof parseMeta>,
  ): Promise<Response> {
    switch (method) {
      case "server/discover":
        return ok(id, {
          resultType: "complete",
          supportedVersions: [PROTOCOL_VERSION],
          capabilities: this.capabilities,
          ...(this.options.instructions ? { instructions: this.options.instructions } : {}),
          _meta: {
            [META.serverInfo]: {
              name: this.options.name,
              version: this.options.version,
            },
          },
        });

      case "tools/list":
        return ok(id, {
          tools: [...this.options.tools.values()].map(toolDescriptor),
        });

      case "resources/list":
        return ok(id, { resources: this.#resourceList() });

      case "resources/read":
        return ok(id, { contents: [this.#read(params["uri"])] });

      case "tools/call":
        return await this.#call(id, params, meta);

      case "prompts/list":
        return ok(id, {
          prompts: [...this.#prompts.values()].map(promptDescriptor),
        });

      case "prompts/get":
        return await this.#prompt(id, params, meta);

      case "subscriptions/listen":
        return await this.#listen(id, params);

      default:
        return err(id, CODE.methodNotFound, `Method not found: ${method}`);
    }
  }

  #resourceList(): Array<Record<string, unknown>> {
    const views = [...this.options.views.values()].map((view) => ({
      uri: view.uri,
      name: view.uri,
      mimeType: APP_MIME,
      _meta: { ui: { prefersBorder: view.prefersBorder ?? true } },
    }));
    const rest = [...this.options.resources.values()].map((resource) => ({
      uri: resource.uri,
      name: resource.name ?? resource.uri,
      mimeType: resource.mimeType ?? "text/plain",
    }));
    return [...views, ...rest];
  }

  #read(uri: unknown): Record<string, unknown> {
    if (typeof uri !== "string") {
      throw new RpcError(CODE.invalidParams, "resources/read needs a string uri");
    }
    const view = this.options.views.get(uri);
    if (view) return viewContents(view);
    const resource = this.options.resources.get(uri);
    // -32002 was the code for this through 2025-11-25. This version forbids
    // emitting it, and an empty contents array for a missing resource is
    // forbidden too, so the only correct answer is an error.
    if (!resource) {
      throw new RpcError(CODE.invalidParams, `Resource not found: ${uri}`);
    }
    const { uri: _uri, name: _name, ...body } = resource;
    return { uri, ...body };
  }

  async #prompt(
    id: Id,
    params: Record<string, unknown>,
    meta: ReturnType<typeof parseMeta>,
  ): Promise<Response> {
    const name = params["name"];
    if (typeof name !== "string") {
      throw new RpcError(CODE.invalidParams, "prompts/get needs a prompt name");
    }
    const prompt = this.#prompts.get(name);
    // Same code as a missing resource, for the same reason: -32002 is retired
    // in this version and a missing thing is a bad parameter.
    if (!prompt) throw new RpcError(CODE.invalidParams, `Unknown prompt: ${name}`);

    const lifetime = new RequestLifetime(
      this.options.defaultTimeoutMs ?? 0, this.options.clock ?? systemClock);
    this.inFlight.add(id, lifetime);
    try {
      const messages = await prompt.handler(
        (params["arguments"] ?? {}) as Record<string, string>,
        this.#context(id, lifetime, meta, new RequestNotifier(
          this.#sink, lifetime, meta.progressToken, meta.logLevel, this.#backpressure),
          params),
      );
      return ok(id, {
        ...(prompt.definition.description
          ? { description: prompt.definition.description } : {}),
        messages,
      });
    } finally {
      lifetime.settle();
      this.inFlight.remove(id);
    }
  }

  /** Open a notification stream, and do not answer until it is torn down.
   *
   * The request stays in flight for the life of the subscription, which is
   * exactly what it is: a request that has not been answered yet. It is
   * cancellable the same way as any other, and when it ends nothing is left
   * behind for the next request to find.
   */
  async #listen(id: Id, params: Record<string, unknown>): Promise<Response> {
    const wanted = (params["notifications"] ?? {}) as SubscriptionFilter;
    if (typeof wanted !== "object" || wanted === null) {
      throw new RpcError(CODE.invalidParams,
        "subscriptions/listen needs a notifications filter");
    }
    // A transport with no way to push cannot carry a stream, and a client left
    // holding a request that will never speak is worse than being told.
    if (!this.streams) {
      throw new RpcError(CODE.invalidRequest,
        "This transport carries no notification stream, so subscriptions/listen "
        + "cannot be served on it. Connect over a transport that does.");
    }

    const honoured = agreed(wanted, {
      tools: true,
      resources: true,
      prompts: this.#prompts.size > 0,
    });

    const lifetime = new RequestLifetime(0, this.options.clock ?? systemClock);
    this.inFlight.add(id, lifetime);
    const ended = this.subscriptions.open(id, honoured);
    // First message on the stream, before anything else carrying this id.
    this.#sink(this.subscriptions.acknowledgement(id, honoured));

    // A cancelled subscription is a closed stream, and the response that
    // closes it is the one the client has been holding all along.
    const onAbort = () => this.subscriptions.close(id);
    lifetime.signal.addEventListener("abort", onAbort, { once: true });

    try {
      return ok(id, await ended);
    } finally {
      lifetime.signal.removeEventListener("abort", onAbort);
      this.subscriptions.close(id);
      lifetime.settle();
      this.inFlight.remove(id);
    }
  }

  /** Whether this dispatcher is attached to something that can push. */
  get streams(): boolean { return this.#sink !== NO_SINK; }

  #context(
    id: Id,
    lifetime: RequestLifetime,
    meta: ReturnType<typeof parseMeta>,
    notifier: RequestNotifier,
    params: Record<string, unknown> = {},
  ): Context {
    // Everything the round-trip pattern needs arrives on this request: what
    // the client was asked for last time, and what it came back with. Nothing
    // is looked up, so any instance can answer the retry.
    const responses: InputResponses = inputResponsesOf(params);
    const state = requestStateOf(params);
    const capabilities = meta.clientCapabilities as Record<string, unknown>;

    const require = (
      requests: InputRequests, nextState?: string,
    ): Record<string, Record<string, unknown>> => {
      const missing: InputRequests = {};
      const found: Record<string, Record<string, unknown>> = {};
      for (const [key, request] of Object.entries(requests)) {
        const answer = responses[key];
        if (answer) found[key] = answer;
        else missing[key] = request;
      }
      if (Object.keys(missing).length) throw new InputRequired(missing, nextState);
      return found;
    };

    return {
      signal: lifetime.signal,
      requestId: id,
      client: meta.clientInfo,
      capabilities: meta.clientCapabilities,
      meta,
      hasInputs: Object.keys(responses).length > 0,
      ...(state !== undefined ? { requestState: state } : {}),
      progress: (progress, total, message) => notifier.progress(progress, total, message),
      log: (level, data) => notifier.log(level, data),
      requireInputs: require,

      elicit: async (key, request) => {
        // Absent is not refused. A client that never declared elicitation has
        // no way to put the question to anybody, and asking it to retry would
        // loop forever.
        if (!capabilities["elicitation"]) {
          return { action: "unavailable", reason: "This client offers no elicitation." };
        }
        const answer = require({
          [key]: {
            method: "elicitation/create",
            params: {
              mode: "form",
              message: request.message,
              requestedSchema: request.requestedSchema,
            },
          },
        })[key]!;
        const action = answer["action"];
        if (action === "accept") {
          return {
            action: "accept",
            content: (answer["content"] ?? {}) as Record<
              string, string | number | boolean | string[]>,
          };
        }
        return action === "decline" ? { action: "decline" } : { action: "cancel" };
      },

      sample: async (key, request) => {
        if (!capabilities["sampling"]) {
          return { ok: false, reason: "absent", detail: "This client offers no sampling." };
        }
        const answer = require({
          [key]: {
            method: "sampling/createMessage",
            params: { ...request } as Record<string, unknown>,
          },
        })[key]!;
        return {
          ok: true,
          model: String(answer["model"] ?? ""),
          role: (answer["role"] as "user" | "assistant") ?? "assistant",
          content: (answer["content"] ?? { type: "text", text: "" }) as
            { type: string; text?: string },
          ...(answer["stopReason"] !== undefined
            ? { stopReason: String(answer["stopReason"]) } : {}),
        };
      },
    };
  }

  async #call(
    id: Id,
    params: Record<string, unknown>,
    meta: ReturnType<typeof parseMeta>,
  ): Promise<Response> {
    const name = params["name"];
    if (typeof name !== "string") {
      throw new RpcError(CODE.invalidParams, "tools/call needs a tool name");
    }
    const tool = this.options.tools.get(name);
    if (!tool) throw new RpcError(CODE.invalidParams, `Unknown tool: ${name}`);

    if (tool.definition.requires?.length) {
      requireCapabilities(meta.clientCapabilities, tool.definition.requires);
    }

    const timeout = tool.definition.timeoutMs ?? this.options.defaultTimeoutMs ?? 0;
    const lifetime = new RequestLifetime(timeout, this.options.clock ?? systemClock);
    const notifier = new RequestNotifier(
      this.#sink, lifetime, meta.progressToken, meta.logLevel, this.#backpressure,
    );
    this.inFlight.add(id, lifetime);

    const context: Context = this.#context(id, lifetime, meta, notifier, params);

    try {
      const input = await validate(tool.definition.input, params["arguments"] ?? {});
      // Validating and queueing both yield, so a cancellation can land before
      // the handler has run at all. Starting it anyway hands it a signal that
      // already fired, and the usual `addEventListener("abort")` then waits
      // for an event in the past. That is an unkillable request, so the check
      // happens here and again inside the limiter, once a queued slot frees.
      if (lifetime.aborted) {
        return err(id, CODE.internal, `Request ${lifetime.reason}`);
      }
      const output = await this.#limiter.run(async () => {
        if (lifetime.aborted) throw new AbortedBeforeStart();
        const result = await tool.handler(input, context);
        return result;
      });

      // A result that arrives after the request was cancelled is discarded.
      // Writing it would be a message for a request the client has abandoned,
      // which this version forbids outright.
      if (lifetime.aborted) {
        return err(id, CODE.internal, `Request ${lifetime.reason}`);
      }
      return ok(id, this.#result(tool, output));
    } catch (error) {
      // Not a failure: the handler is telling the client what to go and get,
      // and the client retries this same request with the answers attached.
      if (error instanceof InputRequired) {
        return ok(id, inputRequiredResult(error.requests, error.state));
      }
      if (error instanceof AbortedBeforeStart) {
        return err(id, CODE.internal, `Request ${lifetime.reason}`);
      }
      if (lifetime.aborted && !(error instanceof RpcError)) {
        return err(id, CODE.internal, `Request ${lifetime.reason}`);
      }
      if (error instanceof RpcError) {
        return err(id, error.code, error.message, error.data);
      }
      // An unexpected throw is a failed call, not a failed connection. It is
      // reported as an error result so the model can see it and react.
      return ok(id, {
        isError: true,
        content: [{ type: "text", text: (error as Error).message ?? "The tool failed." }],
      });
    } finally {
      lifetime.settle();
      this.inFlight.remove(id);
    }
  }

  #result(tool: RegisteredTool, output: unknown): Record<string, unknown> {
    // The view gets the data; the model gets a sentence. A tool that returns
    // rows and hands them all to the model is the commonest way to make an
    // app expensive and vague at the same time.
    const summary = tool.definition.summary?.(output as never);
    const text = summary ?? (typeof output === "string" ? output : undefined);
    return {
      content: text !== undefined ? [{ type: "text", text }] : [],
      ...(output !== undefined && typeof output === "object" && output !== null
        ? { structuredContent: output as Record<string, unknown> }
        : {}),
    };
  }
}
