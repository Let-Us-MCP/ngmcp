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
export type Schema<T = unknown> = StandardSchema<T> | JsonSchema;

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
}

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
