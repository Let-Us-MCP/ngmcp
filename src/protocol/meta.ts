import { META, PROTOCOL_VERSION } from "./version.js";
import {
  MissingRequiredClientCapabilityError,
  RpcError,
  CODE,
  UnsupportedProtocolVersionError,
} from "./errors.js";

export interface ClientInfo {
  name: string;
  version?: string;
  title?: string;
  [key: string]: unknown;
}

export type ClientCapabilities = Record<string, unknown>;

/** Everything a request says about itself.
 *
 * In `2026-07-28` this replaces the connection state a session used to hold.
 * It is built per request and thrown away with the request, which is what
 * makes concurrency here a scheduling problem rather than a locking one.
 */
export interface RequestMeta {
  protocolVersion: string;
  clientInfo?: ClientInfo;
  clientCapabilities: ClientCapabilities;
  logLevel?: string;
  progressToken?: string | number;
  /** Everything else, kept so nothing is silently dropped in transit. */
  raw: Record<string, unknown>;
}

/** Methods that must answer before a version is agreed.
 *
 * `server/discover` is how a client learns which versions exist, so gating it
 * on the version would make it useless for the one job it has. It still has
 * to carry the required fields; it just is not refused for disagreeing.
 */
const VERSION_EXEMPT = new Set(["server/discover"]);

export function parseMeta(method: string, params: unknown): RequestMeta {
  const raw = (params && typeof params === "object" && "_meta" in params
    ? (params as { _meta?: unknown })._meta
    : undefined) as Record<string, unknown> | undefined;

  const missing: string[] = [];
  const protocolVersion = raw?.[META.protocolVersion];
  const clientCapabilities = raw?.[META.clientCapabilities];

  // Both are required on every request. A server that lets these slide is
  // relying on prior connection state, which this version forbids outright.
  if (typeof protocolVersion !== "string") missing.push(META.protocolVersion);
  if (clientCapabilities === undefined || typeof clientCapabilities !== "object"
      || clientCapabilities === null) {
    missing.push(META.clientCapabilities);
  }
  if (missing.length) {
    throw new RpcError(
      CODE.invalidParams,
      `Request is missing required _meta field(s): ${missing.join(", ")}`,
      { missing },
    );
  }

  if (!VERSION_EXEMPT.has(method) && protocolVersion !== PROTOCOL_VERSION) {
    throw new UnsupportedProtocolVersionError(protocolVersion, [PROTOCOL_VERSION]);
  }

  const info = raw?.[META.clientInfo];
  const token = raw?.[META.progressToken];
  return {
    protocolVersion: protocolVersion as string,
    clientInfo: (info && typeof info === "object" ? info : undefined) as ClientInfo | undefined,
    clientCapabilities: clientCapabilities as ClientCapabilities,
    logLevel: typeof raw?.[META.logLevel] === "string"
      ? (raw[META.logLevel] as string) : undefined,
    progressToken: typeof token === "string" || typeof token === "number"
      ? token : undefined,
    raw: raw ?? {},
  };
}

/** Look up a dotted capability path, e.g. "elicitation.form". */
export function hasCapability(caps: ClientCapabilities, path: string): boolean {
  let node: unknown = caps;
  for (const part of path.split(".")) {
    if (typeof node !== "object" || node === null) return false;
    if (!(part in node)) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return node !== undefined && node !== null && node !== false;
}

/** Throw the specified error unless the client declared every capability. */
export function requireCapabilities(
  caps: ClientCapabilities,
  required: readonly string[],
): void {
  const absent = required.filter((path) => !hasCapability(caps, path));
  if (absent.length) throw new MissingRequiredClientCapabilityError(absent);
}
