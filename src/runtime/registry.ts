import { APP_MIME } from "../protocol/version.js";
import { RpcError, CODE } from "../protocol/errors.js";
import type { RequestMeta, ClientInfo, ClientCapabilities } from "../protocol/meta.js";

/** The subset of Standard Schema this runtime uses. */
export interface StandardSchema<Out = unknown> {
  "~standard": {
    version: 1;
    vendor: string;
    validate(value: unknown):
      | { value: Out; issues?: undefined }
      | { issues: ReadonlyArray<{ message: string; path?: unknown }> }
      | Promise<
          | { value: Out; issues?: undefined }
          | { issues: ReadonlyArray<{ message: string; path?: unknown }> }
        >;
    types?: { input: unknown; output: Out };
  };
}

export type JsonSchema = Record<string, unknown>;
/** A JSON Schema that remembers the TypeScript type it describes.
 *
 * The phantom is never present at runtime. It exists so that a contract
 * declared with `type<T>()` still knows what T was by the time a view reads
 * it, which is the whole mechanism behind the shared contract. */
export type TypedJsonSchema<T> = JsonSchema & { readonly __type?: T };
export type Schema<T = unknown> = StandardSchema<T> | TypedJsonSchema<T>;

export const isStandardSchema = (s: unknown): s is StandardSchema =>
  typeof s === "object" && s !== null && "~standard" in s;

/** What a handler is given. Built per request and discarded with it. */
export interface Context {
  readonly signal: AbortSignal;
  readonly requestId: string | number;
  readonly client?: ClientInfo;
  readonly capabilities: ClientCapabilities;
  readonly meta: RequestMeta;
  progress(progress: number, total?: number, message?: string): void;
  log(level: "debug" | "info" | "warning" | "error", data: unknown): void;
  /** Ask the person, through the client, under the round-trip pattern.
   *
   * Returns the answer if the client has already supplied it; otherwise throws
   * `InputRequired`, which the dispatcher turns into an `input_required`
   * result. The client gathers the answer and **retries the same request**,
   * and this handler runs again from the top with the answer available.
   *
   * `key` names the request so the answer can be matched to it. It must be
   * stable across the retry — deriving it from the arguments is fine, deriving
   * it from a clock or a counter is not.
   *
   * Three answers plus one: accept, decline and cancel are the person's, and
   * `unavailable` is the client's, for a host that never offered elicitation
   * at all. A handler that treats the fourth as a decline is making a decision
   * on somebody's behalf. */
  elicit(key: string, request: ElicitRequest): Promise<ElicitOutcome>;
  /** Ask the client's model for a completion, the same way. */
  sample(key: string, request: SampleRequest): Promise<SampleOutcome>;
  /** Ask for several things in one round trip rather than one per trip. */
  requireInputs(requests: Record<string, {
    method: string; params: Record<string, unknown>;
  }>, state?: string): Record<string, Record<string, unknown>>;
  /** What the client echoed back, for a handler that asked for one. */
  readonly requestState?: string;
  /** Whether this is a retry carrying answers, which a handler rarely needs
   *  to know and occasionally does. */
  readonly hasInputs: boolean;
}

export interface ElicitRequest {
  message: string;
  /** Primitive properties only: the specification does not allow nesting. */
  requestedSchema: {
    type: "object";
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
  };
}

export type ElicitOutcome =
  | { action: "accept"; content: Record<string, string | number | boolean | string[]> }
  | { action: "decline" }
  | { action: "cancel" }
  | { action: "unavailable"; reason: string };

/** What a handler is told when the client cannot be asked at all. */
export const UNAVAILABLE_ELICIT = (reason: string): ElicitOutcome =>
  ({ action: "unavailable", reason });

export interface SampleRequest {
  messages: Array<{ role: "user" | "assistant"; content: { type: string; text?: string } }>;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  modelPreferences?: Record<string, unknown>;
}

export type SampleOutcome =
  | {
      ok: true;
      model: string;
      role: "user" | "assistant";
      content: { type: string; text?: string };
      stopReason?: string;
    }
  | { ok: false; reason: "absent" | "refused"; detail: string };

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  [key: string]: unknown;
}

export interface ToolDefinition<In = unknown, Out = unknown> {
  description?: string;
  title?: string;
  /** Standard Schema (validated) or raw JSON Schema (published as given). */
  input?: Schema<In>;
  output?: Schema<Out>;
  annotations?: ToolAnnotations;
  /** The view this tool renders into, as a `ui://` uri registered on the app. */
  view?: string;
  visibility?: Array<"model" | "app">;
  /** Client capabilities this tool cannot run without. */
  requires?: string[];
  timeoutMs?: number;
  /** One sentence for the model. The data goes to the view, not the model. */
  summary?: (output: Out) => string;
}

export interface RegisteredTool<In = unknown, Out = unknown> {
  name: string;
  definition: ToolDefinition<In, Out>;
  handler: (input: In, context: Context) => Out | Promise<Out>;
}

export interface ViewDefinition {
  uri: string;
  html: string;
  /** Content security policy the host applies to the frame. */
  csp?: Record<string, unknown>;
  prefersBorder?: boolean;
  [key: string]: unknown;
}

export interface PromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

/** A prompt the server offers, and what it needs to be filled in.
 *
 * Prompts are the one primitive here with no view: they are text a person
 * chose, handed to a model. They are stateless in the same way everything else
 * is, because `prompts/get` carries its own arguments. */
export interface PromptDefinition {
  name: string;
  title?: string;
  description?: string;
  arguments?: PromptArgument[];
}

export interface PromptMessage {
  role: "user" | "assistant";
  content: { type: string; text?: string; [key: string]: unknown };
}

export interface RegisteredPrompt {
  name: string;
  definition: PromptDefinition;
  handler: (
    args: Record<string, string>, context: Context,
  ) => PromptMessage[] | Promise<PromptMessage[]>;
}

export function promptDescriptor(prompt: RegisteredPrompt): Record<string, unknown> {
  const { definition } = prompt;
  return {
    name: prompt.name,
    ...(definition.title ? { title: definition.title } : {}),
    ...(definition.description ? { description: definition.description } : {}),
    ...(definition.arguments?.length ? { arguments: definition.arguments } : {}),
  };
}

export interface ResourceDefinition {
  uri: string;
  name?: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

/** Turn a schema into the JSON Schema a tool descriptor must publish.
 *
 * `inputSchema` MUST be a JSON Schema object and MUST NOT be null, so a tool
 * with no parameters publishes an empty object schema rather than nothing.
 */
export function toJsonSchema(schema: Schema | undefined): JsonSchema {
  if (!schema) return { type: "object" };
  if (isStandardSchema(schema)) {
    const withJson = schema as unknown as { toJSONSchema?: () => JsonSchema };
    if (typeof withJson.toJSONSchema === "function") return withJson.toJSONSchema();
    // A vendor that cannot describe itself still gets a valid object schema,
    // which is publishable and honest about knowing nothing more.
    return { type: "object" };
  }
  return schema;
}

export async function validate<T>(schema: Schema<T> | undefined, value: unknown): Promise<T> {
  if (!schema) return value as T;
  if (isStandardSchema(schema)) {
    const result = await schema["~standard"].validate(value);
    if ("issues" in result && result.issues) {
      throw new RpcError(CODE.invalidParams, "Invalid parameters", {
        issues: result.issues.map((i) => ({
          message: i.message,
          path: i.path ?? [],
        })),
      });
    }
    return (result as { value: T }).value;
  }
  // A raw JSON Schema is published as the author wrote it. Only the top-level
  // required keys are checked here, and that limit is stated rather than
  // implied: bring a Standard Schema if you want the rest enforced.
  const required = (schema as { required?: unknown }).required;
  if (Array.isArray(required)) {
    const object = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
    const missing = required.filter((key) => typeof key === "string" && !(key in object));
    if (missing.length) {
      throw new RpcError(CODE.invalidParams,
        `Missing required argument(s): ${missing.join(", ")}`, { missing });
    }
  }
  return value as T;
}

export function toolDescriptor(tool: RegisteredTool): Record<string, unknown> {
  const { definition } = tool;
  const ui: Record<string, unknown> = {};
  if (definition.view) ui["resourceUri"] = definition.view;
  if (definition.visibility) ui["visibility"] = definition.visibility;
  return {
    name: tool.name,
    ...(definition.title ? { title: definition.title } : {}),
    ...(definition.description ? { description: definition.description } : {}),
    inputSchema: toJsonSchema(definition.input),
    ...(definition.output ? { outputSchema: toJsonSchema(definition.output) } : {}),
    ...(definition.annotations ? { annotations: definition.annotations } : {}),
    ...(Object.keys(ui).length ? { _meta: { ui } } : {}),
  };
}

export function viewContents(view: ViewDefinition): Record<string, unknown> {
  const { uri, html, csp, prefersBorder, ...rest } = view;
  return {
    uri,
    mimeType: APP_MIME,
    text: html,
    _meta: {
      ui: {
        csp: csp ?? {},
        prefersBorder: prefersBorder ?? true,
        ...rest,
      },
    },
  };
}
