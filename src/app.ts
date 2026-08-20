import { Dispatcher, type DispatcherOptions } from "./runtime/dispatch.js";
import { StdioTransport } from "./transport/stdio.js";
import type {
  Context, RegisteredTool, ResourceDefinition, Schema, ToolDefinition, ViewDefinition,
} from "./runtime/registry.js";
import type { Incoming, Response } from "./protocol/jsonrpc.js";

export interface AppOptions {
  name: string;
  version?: string;
  instructions?: string;
  /** Tools running at once. Zero, the default, means unbounded. */
  concurrency?: number;
  /** Applied to any tool that does not set its own. Zero means none. */
  defaultTimeoutMs?: number;
}

/** Infers a tool's output type, so a view can be typed against its tool.
 *
 * This is the type that stops the contract being written twice. The server
 * declares the shape once; `ViewProps` gives the view the same shape, and a
 * change on either side stops compiling on both.
 */
export type Output<T> = T extends { __output: infer O } ? O : never;

export interface ToolHandle<Out> { readonly __output: Out; readonly name: string }

export type ViewProps<T> = { data: Output<T> };

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

  /** Register a plain resource. */
  resource(uri: string, resource: Omit<ResourceDefinition, "uri">): string {
    this.#resources.set(uri, { uri, ...resource });
    return uri;
  }

  get dispatcher(): Dispatcher {
    if (!this.#dispatcher) {
      const options: DispatcherOptions = {
        name: this.options.name,
        version: this.options.version ?? "0.0.0",
        tools: this.#tools,
        views: this.#views,
        resources: this.#resources,
        concurrency: this.options.concurrency ?? 0,
        defaultTimeoutMs: this.options.defaultTimeoutMs ?? 0,
      };
      if (this.options.instructions) options.instructions = this.options.instructions;
      this.#dispatcher = new Dispatcher(options);
    }
    return this.#dispatcher;
  }

  /** Answer one message. The whole server, with no transport attached. */
  handle(message: Incoming): Promise<Response | null> {
    return this.dispatcher.handle(message);
  }

  /** Serve over stdio. */
  serve(): StdioTransport {
    const transport = new StdioTransport(this.dispatcher);
    transport.start();
    return transport;
  }
}

export type { Context, ToolDefinition, ViewDefinition, Schema };
