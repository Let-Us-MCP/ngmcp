/** The view's half of the contract.
 *
 * `client<typeof contracts>()` gives one method per declared tool, with the
 * declared argument type and the declared result type. The view stops writing
 * `result.structuredContent?.deployments ?? []` and starts writing
 * `(await api.list_deployments({})).deployments`, which is the same sentence
 * with the doubt removed.
 *
 * The contract is imported as a type. Nothing of the server reaches the
 * bundle, and nothing here knows which server is on the other end.
 */
import type { Contracts, InputOf, OutputOf } from "../contract/define.js";

/** What the host bridge must provide. Both `ext-apps` and the emulator in the
 *  cookbook already do; anything else needs eight lines. */
export interface Bridge {
  callServerTool(name: string, args: Record<string, unknown>): Promise<{
    structuredContent?: unknown;
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  }>;
}

/** One method per declared tool.
 *
 * `-?` strips optionality that `noUncheckedIndexedAccess` would otherwise add,
 * because every key in a contract is a tool that exists. Without it a view has
 * to write `api.list_deployments?.()`, which reintroduces exactly the doubt
 * the contract removes. */
export type Client<C extends Contracts> = {
  [K in keyof C]-?: (input?: InputOf<C[K]>) => Promise<OutputOf<C[K]>>;
};

export class ToolError extends Error {
  constructor(readonly tool: string, message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export interface ClientOptions {
  bridge: Bridge;
  /** Called with whatever the model was told, when a tool returns text. */
  onText?: (tool: string, text: string) => void;
}

/** Build a typed client over a bridge. The contract is a type parameter, so
 *  this costs nothing at runtime beyond a Proxy. */
export function client<C extends Contracts>(options: ClientOptions): Client<C> {
  const { bridge, onText } = options;
  return new Proxy({} as Client<C>, {
    get(_target, property: string | symbol) {
      if (typeof property !== "string") return undefined;
      return async (input: Record<string, unknown> = {}) => {
        const result = await bridge.callServerTool(property, input);
        const text = result.content?.find((c) => c.type === "text")?.text;
        if (text) onText?.(property, text);
        if (result.isError) {
          throw new ToolError(property, text ?? "The tool failed.");
        }
        // `structuredContent` is the contract's output. A tool that declared
        // one and returned nothing is a server bug, and saying so here beats
        // handing the view an undefined it will spread `?? []` over.
        return result.structuredContent as never;
      };
    },
  });
}

/** A bridge for tests and for the dev loop: answers from a plain object. */
export function fakeBridge(
  answers: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>,
): Bridge {
  return {
    async callServerTool(name, args) {
      if (!(name in answers)) {
        return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
      }
      const answer = answers[name];
      const value = typeof answer === "function"
        ? (answer as (a: Record<string, unknown>) => unknown)(args) : answer;
      return { structuredContent: await value };
    },
  };
}
