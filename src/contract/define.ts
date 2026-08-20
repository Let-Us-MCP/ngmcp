/** One declaration, both sides.
 *
 * The problem this exists for: a tool returns `structuredContent` and a view
 * reads it, and without something binding them the shape is written twice.
 * The view then defends itself with `?.` and `?? []` against a server it
 * cannot see, and the two drift until someone notices at runtime.
 *
 * A contract is declared once, in a file both halves import. The server is
 * type-checked against it when it implements a tool; the view is type-checked
 * against it when it calls one. Neither imports the other, and the view
 * imports only types, so nothing of the server reaches the bundle.
 */
import type { JsonSchema, Schema } from "../runtime/registry.js";
import type { ToolAnnotations } from "../runtime/registry.js";

/** What a schema promises to produce, when it can say. */
export type Infer<S> =
  S extends { "~standard": { types?: { output: infer O } } } ? O
  : S extends { readonly __type?: infer T } ? T
  : unknown;

export interface ToolContract<In = unknown, Out = unknown> {
  description?: string;
  title?: string;
  input?: Schema<In>;
  output?: Schema<Out>;
  annotations?: ToolAnnotations;
  /** The `ui://` uri of the view this tool renders into. */
  view?: string;
  visibility?: Array<"model" | "app">;
  requires?: string[];
  timeoutMs?: number;
  /** One sentence for the model. The data goes to the view. */
  summary?: (output: Out) => string;
  /** Present only to carry types. Never read at runtime. */
  readonly __in?: In;
  readonly __out?: Out;
}

/** A contract with its type parameters forgotten.
 *
 * `ToolContract<never, never>` looks like the right bound and is not: nothing
 * is assignable to `Schema<never>`, so every real contract is rejected. The
 * types are read off the phantom by `InputOf` and `OutputOf` instead, so the
 * bound only has to describe the shape. */
export interface AnyToolContract {
  description?: string;
  title?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input?: Schema<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  output?: Schema<any>;
  annotations?: ToolAnnotations;
  view?: string;
  visibility?: Array<"model" | "app">;
  requires?: string[];
  timeoutMs?: number;
  /** One sentence for the model. The data goes to the view. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  summary?: (output: any) => string;
}

export type Contracts = Record<string, AnyToolContract>;

/** Declare a shape by its TypeScript type, with an optional JSON Schema for
 *  the wire.
 *
 * The point of a contract is the type, and a validation library is a separate
 * decision. `type<T>()` lets a contract be written with neither, and a
 * Standard Schema can be dropped in later without the view changing.
 */
export function type<T>(jsonSchema?: JsonSchema): Schema<T> {
  return (jsonSchema ?? { type: "object" }) as Schema<T>;
}

/** Declare a set of tools. Import this from the server and, as a type, from
 *  the view. */
export function defineTools<C extends Contracts>(contracts: C): C {
  return contracts;
}

/** Declare one tool, when a set is more ceremony than it is worth. */
export function defineTool<In, Out>(
  contract: ToolContract<In, Out>,
): ToolContract<In, Out> {
  return contract;
}

/** The argument type of a declared tool. */
export type InputOf<C> = C extends { input?: infer S }
  ? [Infer<S>] extends [unknown]
    ? Infer<S> extends never ? Record<string, never> : Infer<S>
    : Infer<S>
  : Record<string, never>;

/** The result type of a declared tool: what the view receives. */
export type OutputOf<C> = C extends { output?: infer S } ? Infer<S> : unknown;

/** What a view rendered by a tool is handed. */
export type ViewProps<C> = { data: OutputOf<C> };

/** The handlers a server must supply to satisfy a contract set.
 *
 * Every key is required and every signature is checked, so adding a tool to
 * the contract breaks the server until it is implemented, rather than being
 * discovered by a client at runtime.
 */
export type Implementation<C extends Contracts, Ctx> = {
  [K in keyof C]: (
    input: InputOf<C[K]>,
    context: Ctx,
  ) => OutputOf<C[K]> | Promise<OutputOf<C[K]>>;
};
