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
  toolDescriptor, validate, viewContents,
  type Context, type RegisteredTool, type ResourceDefinition, type ViewDefinition,
} from "./registry.js";

export interface DispatcherOptions {
  name: string;
  version: string;
  instructions?: string;
  tools: Map<string, RegisteredTool>;
  views: Map<string, ViewDefinition>;
  resources: Map<string, ResourceDefinition>;
  /** Zero means unbounded, which statelessness makes a reasonable default. */
  concurrency?: number;
  defaultTimeoutMs?: number;
  clock?: Clock;
  backpressure?: Backpressure;
}

/** Raised when a request dies while queued, so it never reaches its handler. */
class AbortedBeforeStart extends Error {}

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
  #sink: Sink = () => {};
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

  get capabilities(): Record<string, unknown> {
    return {
      tools: { listChanged: false },
      resources: { listChanged: false },
      extensions: {
        [UI_EXTENSION]: { mimeTypes: [APP_MIME] },
      },
    };
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

    const context: Context = {
      signal: lifetime.signal,
      requestId: id,
      client: meta.clientInfo,
      capabilities: meta.clientCapabilities,
      meta,
      progress: (progress, total, message) => notifier.progress(progress, total, message),
      log: (level, data) => notifier.log(level, data),
    };

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
