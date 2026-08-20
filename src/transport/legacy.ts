/** Speaking to a host that still expects a handshake.
 *
 * Every shipping host today opens with `initialize` and a protocol version
 * older than `2026-07-28`. This server does not have an `initialize`, on
 * purpose, and refuses versions it does not speak, also on purpose. Both of
 * those are correct and neither of them helps somebody trying to open a view
 * in Claude Desktop this afternoon.
 *
 * So: a shim. It sits in front of the dispatcher, answers the handshake, and
 * fills in the `_meta` an older client does not know to send.
 *
 * **It holds nothing.** That is the part worth being careful about, because
 * the obvious implementation is to remember what `initialize` said and replay
 * it onto later requests, and that is exactly the session this package exists
 * without. Instead the capabilities a legacy client would have declared are
 * **declared here, by whoever runs the server**, as configuration. The
 * handshake is answered from fixed values and immediately forgotten; two
 * processes behind a load balancer still answer identically; killing and
 * restarting the server mid-conversation changes nothing.
 *
 * What that costs is honesty about one thing: a legacy client's real
 * capabilities are not known per request, so `assume` is a statement about the
 * host rather than an observation of it. Set it to what the host actually
 * offers. Getting it wrong means a tool that requires a capability is offered
 * to a host that cannot honour it, which fails at the call rather than
 * silently — the same failure a `requires` declaration exists to produce.
 */
import type { Dispatcher } from "../runtime/dispatch.js";
import type { Incoming, Request, Response } from "../protocol/jsonrpc.js";
import { PROTOCOL_VERSION, META } from "../protocol/version.js";

export interface LegacyOptions {
  name: string;
  version?: string;
  instructions?: string;
  /** Versions to accept from a client that opens with `initialize`.
   *
   * The version answered is whichever of these the client asked for, because a
   * client that hears a version it did not offer usually gives up. */
  speak?: readonly string[];
  /** What a legacy client is taken to be able to do.
   *
   * Configuration rather than memory: see the note at the top of this file.
   * The default is what a desktop host with an app surface typically offers. */
  assume?: Record<string, unknown>;
  /** Reported back as the client, when the client did not say. */
  clientName?: string;
}

const DEFAULT_SPEAK = ["2025-06-18", "2025-11-25", "2026-07-28"] as const;

const DEFAULT_ASSUME: Record<string, unknown> = {
  // What a host that renders MCP Apps normally has. Narrow it if yours does
  // not: an assumption that is too generous produces a refusal at the call,
  // which is the failure mode `requires` exists to give you.
  roots: {},
  sampling: {},
  elicitation: { form: {} },
  "io.modelcontextprotocol/ui": {},
};

/** Wrap a dispatcher so an older host can talk to it.
 *
 * Returns a `handle` with the same shape as the dispatcher's, so it drops into
 * any transport here. */
export function legacyBridge(
  dispatcher: Dispatcher, options: LegacyOptions,
): { handle(message: Incoming): Promise<Response | null> } {
  const speak = options.speak ?? DEFAULT_SPEAK;
  const assume = options.assume ?? DEFAULT_ASSUME;

  return {
    async handle(message: Incoming): Promise<Response | null> {
      const request = message as Request;
      const method = request.method;

      if (method === "initialize") {
        const asked = (request.params as { protocolVersion?: string } | undefined)
          ?.protocolVersion;
        // Answer in the client's own version when it is one we can serve
        // through this shim. A client that hears a version it did not offer
        // usually stops there.
        const answered = asked && speak.includes(asked) ? asked : speak[speak.length - 1]!;
        return {
          jsonrpc: "2.0", id: request.id,
          result: {
            protocolVersion: answered,
            capabilities: dispatcher.capabilities,
            serverInfo: {
              name: options.name,
              version: options.version ?? "0.0.0",
            },
            ...(options.instructions ? { instructions: options.instructions } : {}),
          },
        };
      }

      // The handshake's second half, and the ping older clients use to check
      // the server is alive. Both are answered and neither is remembered.
      if (method === "notifications/initialized" || method === "initialized") return null;
      if (method === "ping") {
        return { jsonrpc: "2.0", id: request.id, result: {} };
      }

      // `resources/subscribe` and `resources/unsubscribe` were replaced by
      // `subscriptions/listen`, which a legacy client does not send. Refusing
      // them is more useful than pretending, because a client that thinks it
      // is subscribed waits for updates that will never come.
      if (method === "resources/subscribe" || method === "resources/unsubscribe") {
        return {
          jsonrpc: "2.0", id: request.id,
          error: {
            code: -32601,
            message: `${method} was replaced by subscriptions/listen in ${PROTOCOL_VERSION}.`,
          },
        };
      }

      return await dispatcher.handle(withMeta(message, assume, options.clientName));
    },
  };
}

/** Put the `_meta` on that a legacy client does not know to send.
 *
 * Anything the client did send is kept: a host halfway through the migration
 * that already sends a progress token or a log level keeps both. Only the two
 * required fields are supplied, and only when they are missing. */
function withMeta(
  message: Incoming, assume: Record<string, unknown>, clientName?: string,
): Incoming {
  const request = message as Request;
  const params = (request.params ?? {}) as Record<string, unknown>;
  const existing = (params["_meta"] ?? {}) as Record<string, unknown>;
  const meta: Record<string, unknown> = { ...existing };

  if (typeof meta[META.protocolVersion] !== "string") {
    meta[META.protocolVersion] = PROTOCOL_VERSION;
  }
  if (typeof meta[META.clientCapabilities] !== "object"
      || meta[META.clientCapabilities] === null) {
    meta[META.clientCapabilities] = assume;
  }
  if (meta[META.clientInfo] === undefined && clientName) {
    meta[META.clientInfo] = { name: clientName, version: "unknown" };
  }
  return { ...request, params: { ...params, _meta: meta } } as Incoming;
}
