import { Dispatcher, type DispatcherOptions } from "./runtime/dispatch.js";
import { StdioTransport } from "./transport/stdio.js";
import { httpHandler, serveHttp, type HttpHandlerOptions } from "./transport/http.js";
import type {
  Context, PromptDefinition, PromptMessage, RegisteredPrompt, RegisteredTool,
  ResourceDefinition, Schema, ToolDefinition, ViewDefinition,
} from "./runtime/registry.js";
import type { Incoming, Response as RpcResponse } from "./protocol/jsonrpc.js";

/* The platform's Response, named apart from the protocol's. Both are called
 * Response and they are entirely different things. */
type FetchRequest = globalThis.Request;
type FetchResponse = globalThis.Response;
import type {
  Contracts, Implementation, ToolContract,
} from "./contract/define.js";

export interface AppOptions {
  name: string;
  version?: string;
  instructions?: string;
  /** Tools running at once. Zero, the default, means unbounded. */
  concurrency?: number;
  /** Applied to any tool that does not set its own. Zero means none. */
  defaultTimeoutMs?: number;
}

export interface ToolHandle<Out> { readonly __output: Out; readonly name: string }

/** An MCP Apps server.
 *
 * Holds tools, views and resources, and nothing about whoever is connected.
 * There is no session object here and there is not meant to be one: the
 * protocol version this targets carries per-request context in `_meta`, so
 * the same instance can answer a stdio pipe, an HTTP handler or a serverless
 * invocation without behaving differently.
 */
export class App {
  readonly #tools = new Map<string, RegisteredTool>();
  readonly #views = new Map<string, ViewDefinition>();
  readonly #resources = new Map<string, ResourceDefinition>();
  readonly #prompts = new Map<string, RegisteredPrompt>();
  #dispatcher: Dispatcher | null = null;

  constructor(private readonly options: AppOptions) {}

  get name(): string { return this.options.name; }

  /** Register a tool. Returns a handle carrying its output type. */
  tool<In, Out>(
    name: string,
    definition: ToolDefinition<In, Out>,
    handler: (input: In, context: Context) => Out | Promise<Out>,
  ): ToolHandle<Out> {
    if (this.#tools.has(name)) {
      throw new Error(`Tool already registered: ${name}`);
    }
    if (definition.view && !this.#views.has(definition.view)) {
      // Registered later is fine; registered never is a tool pointing at a
      // view the host will ask for and not get.
      queueMicrotask(() => {
        if (!this.#views.has(definition.view as string)) {
          throw new Error(
            `Tool ${name} names view ${definition.view}, which was never registered`);
        }
      });
    }
    this.#tools.set(name, {
      name,
      definition: definition as ToolDefinition,
      handler: handler as RegisteredTool["handler"],
    });
    return { __output: undefined as Out, name };
  }

  /** Register a view. The uri is what a tool points at. */
  view(uri: string, view: Omit<ViewDefinition, "uri">): string {
    this.#views.set(uri, { ...view, uri } as ViewDefinition);
    return uri;
  }

  /** Implement a declared contract set.
   *
   * Every tool in the contract must be supplied and every signature is
   * checked, so adding a tool to the shared declaration stops the server
   * compiling until it is implemented. That is the whole point: the failure
   * happens at the keyboard rather than at a client.
   */
  implement<C extends Contracts>(
    contracts: C,
    handlers: Implementation<C, Context>,
  ): this {
    for (const name of Object.keys(contracts)) {
      const contract = contracts[name] as ToolContract<unknown, unknown>;
      const handler = handlers[name as keyof C] as
        (input: unknown, context: Context) => unknown;
      const definition: ToolDefinition = {};
      if (contract.description) definition.description = contract.description;
      if (contract.title) definition.title = contract.title;
      if (contract.input) definition.input = contract.input as never;
      if (contract.output) definition.output = contract.output as never;
      if (contract.annotations) definition.annotations = contract.annotations;
      if (contract.view) definition.view = contract.view;
      if (contract.visibility) definition.visibility = contract.visibility;
      if (contract.requires) definition.requires = contract.requires;
      if (contract.timeoutMs !== undefined) definition.timeoutMs = contract.timeoutMs;
      if (contract.summary) {
        definition.summary = contract.summary as (output: unknown) => string;
      }
      this.tool(name, definition, handler);
    }
    return this;
  }

  /** Register a prompt: text a person chose, handed to a model.
   *
   * Stateless like everything else here. `prompts/get` carries its arguments,
   * so nothing is remembered between listing a prompt and filling it in. */
  prompt(
    name: string,
    definition: Omit<PromptDefinition, "name">,
    handler: (
      args: Record<string, string>, context: Context,
    ) => PromptMessage[] | Promise<PromptMessage[]>,
  ): this {
    if (this.#prompts.has(name)) {
      throw new Error(`Prompt already registered: ${name}`);
    }
    this.#prompts.set(name, { name, definition: { ...definition, name }, handler });
    return this;
  }

  /** Tell every subscription watching this uri that it changed.
   *
   * The route by which a dashboard panel updates without a conversation turn.
   * Nothing reaches a client that did not ask for it: a client with no
   * matching `subscriptions/listen` filter hears nothing, and this returns
   * how many notifications actually went out. */
  resourceUpdated(uri: string): number {
    return this.dispatcher.resourceUpdated(uri);
  }

  /** The same, for the three list-changed notifications. */
  listChanged(what: "tools" | "prompts" | "resources"): number {
    return this.dispatcher.notify(`notifications/${what}/list_changed`);
  }

  /** Register a plain resource. */
  resource(uri: string, resource: Omit<ResourceDefinition, "uri">): string {
    this.#resources.set(uri, { uri, ...resource });
    return uri;
  }

  /** The `ui://` uris registered on this app, in registration order. */
  get viewUris(): string[] {
    return [...this.#views.keys()];
  }

  get dispatcher(): Dispatcher {
    if (!this.#dispatcher) {
      const options: DispatcherOptions = {
        name: this.options.name,
        version: this.options.version ?? "0.0.0",
        tools: this.#tools,
        views: this.#views,
        resources: this.#resources,
        prompts: this.#prompts,
        concurrency: this.options.concurrency ?? 0,
        defaultTimeoutMs: this.options.defaultTimeoutMs ?? 0,
      };
      if (this.options.instructions) options.instructions = this.options.instructions;
      this.#dispatcher = new Dispatcher(options);
    }
    return this.#dispatcher;
  }

  /** Answer one message. The whole server, with no transport attached. */
  handle(message: Incoming): Promise<RpcResponse | null> {
    return this.dispatcher.handle(message);
  }

  /** Serve over stdio. */
  serve(): StdioTransport {
    const transport = new StdioTransport(this.dispatcher);
    transport.start();
    return transport;
  }

  /** A `Request` to `Response` handler: Node, Workers, Deno, Bun.
   *
   * The same object that serves stdio. Nothing about it changes, because
   * nothing about it was per-connection to begin with. */
  fetch(options?: HttpHandlerOptions): (request: FetchRequest) => Promise<FetchResponse> {
    return httpHandler(this.dispatcher, options);
  }

  /** Serve over HTTP with Node's built-in server. */
  serveHttp(options?: HttpHandlerOptions & { port?: number; hostname?: string }) {
    return serveHttp(this.dispatcher, options);
  }
}

export type {
  Context, ToolDefinition, ViewDefinition, Schema, PromptDefinition, PromptMessage,
};
