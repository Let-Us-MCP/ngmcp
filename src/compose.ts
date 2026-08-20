/** One server in front of several.
 *
 * The interesting dashboard shows deployments from one server next to
 * incidents from another. Nothing in the extension describes how, and it is
 * the largest thing missing, so this is an answer rather than the answer.
 *
 * What makes it possible here is the same thing everything else rests on. A
 * request carries its own protocol version and its own client capabilities, so
 * forwarding one is copying it: there is no handshake to replay for the
 * upstream, no session to establish first, and no negotiated state that has to
 * be kept in step between the gateway and the servers behind it. The caller's
 * `_meta` travels with the call, which means an upstream tool that requires a
 * capability sees the real client's capabilities rather than the gateway's.
 * Under a session-shaped protocol this file would be a connection manager.
 *
 * Two things it does not do, deliberately:
 *
 * - **It remembers nothing about a caller.** Upstream connections are shared
 *   by everyone and carry nothing about who asked. A gateway that kept a
 *   per-caller anything would be the session this whole package exists to be
 *   rid of, moved one layer out.
 * - **It does not fail as a unit.** One upstream being down is one upstream
 *   missing from a listing, reported as such, not an error for the whole
 *   board. This is the same rule the dashboard panels follow, for the same
 *   reason: a composition that is only as available as its least available
 *   member is worse than its parts.
 */
import { CODE } from "./protocol/errors.js";
import { APP_MIME, PROTOCOL_VERSION, META } from "./protocol/version.js";
import type { Id, Incoming, Request, Response } from "./protocol/jsonrpc.js";
import type { App } from "./app.js";

/** How the gateway reaches one server behind it. */
export interface UpstreamTransport {
  /** Send one message and wait for its answer. */
  request(message: Request, signal?: AbortSignal): Promise<Response>;
}

export interface Upstream {
  /** Namespace for everything this server contributes. No dots or slashes. */
  name: string;
  transport: UpstreamTransport;
  /** Shown when this upstream cannot be reached. */
  description?: string;
}

export interface ComposeOptions {
  name: string;
  version?: string;
  instructions?: string;
  upstreams: readonly Upstream[];
  /** Between the namespace and the upstream's own tool name. */
  separator?: string;
}

/** An upstream reached over HTTP. Stateless end to end: one request, one
 *  response, nothing kept between them, no sticky routing to arrange. */
export function httpUpstream(url: string, init: RequestInit = {}): UpstreamTransport {
  return {
    async request(message, signal) {
      const response = await fetch(url, {
        ...init,
        method: "POST",
        headers: { "content-type": "application/json", ...(init.headers ?? {}) },
        body: JSON.stringify(message),
        ...(signal ? { signal } : {}),
      });
      if (response.status === 202) {
        return { jsonrpc: "2.0", id: message.id, result: {} };
      }
      return await response.json() as Response;
    },
  };
}

/** An upstream in this process. The composition costs a function call. */
export function localUpstream(app: App): UpstreamTransport {
  return {
    async request(message) {
      const answer = await app.handle(message as Incoming);
      return answer ?? { jsonrpc: "2.0", id: message.id, result: {} };
    },
  };
}

const isFailure = (r: Response): r is Extract<Response, { error: unknown }> =>
  "error" in r;

interface Routed {
  upstream: Upstream;
  /** The name as the upstream knows it. */
  local: string;
}

/** A gateway: one server whose tools are other servers' tools.
 *
 * Answers the same protocol as anything else here, so a host cannot tell that
 * it is composed, and the servers behind it never learn they are.
 */
export class Composed {
  readonly #upstreams: readonly Upstream[];
  readonly #separator: string;

  constructor(private readonly options: ComposeOptions) {
    this.#separator = options.separator ?? ".";
    for (const upstream of options.upstreams) {
      if (upstream.name.includes("/") || upstream.name.includes(this.#separator)) {
        throw new Error(
          `Upstream name ${upstream.name} contains the separator, so nothing it `
          + `contributes could be routed back to it.`);
      }
    }
    this.#upstreams = options.upstreams;
  }

  /** Namespace a name the way this gateway publishes it. */
  qualify(upstream: string, name: string): string {
    return `${upstream}${this.#separator}${name}`;
  }

  /** And back again. Null when nothing owns it. */
  route(qualified: string): Routed | null {
    const at = qualified.indexOf(this.#separator);
    if (at < 0) return null;
    const prefix = qualified.slice(0, at);
    const upstream = this.#upstreams.find((u) => u.name === prefix);
    if (!upstream) return null;
    return { upstream, local: qualified.slice(at + this.#separator.length) };
  }

  /** `ui://data/table` from `deploys` is published as `ui://deploys/data/table`.
   *
   * Two servers both registering `ui://app/table` is the normal case rather
   * than the unlucky one, and a view is fetched by uri, so the uri has to say
   * which server it came from. The first path segment does it, and it reverses
   * without anything being remembered. */
  qualifyUri(upstream: string, uri: string): string {
    const at = uri.indexOf("://");
    if (at < 0) return uri;
    return `${uri.slice(0, at + 3)}${upstream}/${uri.slice(at + 3)}`;
  }

  routeUri(uri: string): { upstream: Upstream; local: string } | null {
    const at = uri.indexOf("://");
    if (at < 0) return null;
    const scheme = uri.slice(0, at + 3);
    const rest = uri.slice(at + 3);
    const slash = rest.indexOf("/");
    if (slash < 0) return null;
    const prefix = rest.slice(0, slash);
    const upstream = this.#upstreams.find((u) => u.name === prefix);
    if (!upstream) return null;
    return { upstream, local: `${scheme}${rest.slice(slash + 1)}` };
  }

  /** Ask every upstream the same question, and keep whatever came back.
   *
   * One that is unreachable contributes nothing and is named in `_meta`, so a
   * client can tell an empty list from a list it could not get. */
  async #fanOut(
    method: string, params: Record<string, unknown>, signal?: AbortSignal,
  ): Promise<{ answers: Array<{ upstream: Upstream; result: Record<string, unknown> }>;
              unreachable: Array<{ name: string; reason: string }> }> {
    const settled = await Promise.all(this.#upstreams.map(async (upstream) => {
      try {
        const answer = await upstream.transport.request(
          { jsonrpc: "2.0", id: `gw-${method}-${upstream.name}`, method, params }, signal);
        if (isFailure(answer)) {
          return { upstream, error: answer.error.message };
        }
        return { upstream, result: answer.result };
      } catch (cause) {
        return {
          upstream,
          error: cause instanceof Error ? cause.message : String(cause),
        };
      }
    }));
    const answers: Array<{ upstream: Upstream; result: Record<string, unknown> }> = [];
    const unreachable: Array<{ name: string; reason: string }> = [];
    for (const one of settled) {
      if ("error" in one && one.error !== undefined) {
        unreachable.push({ name: one.upstream.name, reason: one.error });
      } else if ("result" in one && one.result) {
        answers.push({ upstream: one.upstream, result: one.result });
      }
    }
    return { answers, unreachable };
  }

  /** Answer one message, as any server here does. */
  async handle(message: Incoming, signal?: AbortSignal): Promise<Response | null> {
    const request = message as Request;
    if (request.id === undefined || request.id === null) {
      // A notification is broadcast: a cancellation has to reach whichever
      // upstream is running the thing being cancelled, and the gateway does
      // not remember which one that was.
      await Promise.all(this.#upstreams.map((u) =>
        u.transport.request(message as Request, signal).catch(() => undefined)));
      return null;
    }
    const params = (request.params ?? {}) as Record<string, unknown>;
    switch (request.method) {
      case "server/discover": return await this.#discover(request.id, params, signal);
      case "tools/list": return await this.#list(request.id, params, "tools", signal);
      case "prompts/list": return await this.#list(request.id, params, "prompts", signal);
      case "resources/list": return await this.#list(request.id, params, "resources", signal);
      case "tools/call": return await this.#forwardNamed(request, "name", signal);
      case "prompts/get": return await this.#forwardNamed(request, "name", signal);
      case "resources/read": return await this.#forwardUri(request, signal);
      default:
        return {
          jsonrpc: "2.0", id: request.id,
          error: { code: CODE.methodNotFound, message: `Method not found: ${request.method}` },
        };
    }
  }

  async #discover(
    id: Id, params: Record<string, unknown>, signal?: AbortSignal,
  ): Promise<Response> {
    const { answers, unreachable } = await this.#fanOut("server/discover", params, signal);
    // The gateway speaks one version, and so must everything behind it: a
    // composition across versions would need a translation layer, and saying
    // so is better than pretending.
    const behind = answers.map(({ upstream, result }) => ({
      name: upstream.name,
      versions: result["supportedVersions"] ?? [],
      capabilities: result["capabilities"] ?? {},
    }));
    return {
      jsonrpc: "2.0", id,
      result: {
        resultType: "complete",
        supportedVersions: [PROTOCOL_VERSION],
        capabilities: {
          tools: { listChanged: true },
          resources: { listChanged: true },
          prompts: { listChanged: true },
          extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [APP_MIME] } },
        },
        ...(this.options.instructions ? { instructions: this.options.instructions } : {}),
        _meta: {
          [META.serverInfo]: {
            name: this.options.name,
            version: this.options.version ?? "0.0.0",
          },
          "ngmcp/composedOf": behind,
          ...(unreachable.length ? { "ngmcp/unreachable": unreachable } : {}),
        },
      },
    };
  }

  async #list(
    id: Id, params: Record<string, unknown>,
    kind: "tools" | "prompts" | "resources", signal?: AbortSignal,
  ): Promise<Response> {
    const method = kind === "resources" ? "resources/list" : `${kind}/list`;
    const { answers, unreachable } = await this.#fanOut(method, params, signal);
    const items: Array<Record<string, unknown>> = [];
    for (const { upstream, result } of answers) {
      for (const item of (result[kind] ?? []) as Array<Record<string, unknown>>) {
        items.push(this.#qualifyItem(upstream.name, kind, item));
      }
    }
    return {
      jsonrpc: "2.0", id,
      result: {
        [kind]: items,
        // An empty list and a list that could not be got are different, and a
        // client that cannot tell them apart will report the wrong thing to
        // whoever is looking at it.
        ...(unreachable.length ? { _meta: { "ngmcp/unreachable": unreachable } } : {}),
      },
    };
  }

  #qualifyItem(
    upstream: string, kind: "tools" | "prompts" | "resources",
    item: Record<string, unknown>,
  ): Record<string, unknown> {
    if (kind === "resources") {
      return { ...item, uri: this.qualifyUri(upstream, String(item["uri"] ?? "")) };
    }
    const qualified: Record<string, unknown> = {
      ...item,
      name: this.qualify(upstream, String(item["name"] ?? "")),
    };
    // A tool names its view by uri, and that uri has just moved.
    const meta = item["_meta"] as Record<string, unknown> | undefined;
    const ui = meta?.["ui"] as Record<string, unknown> | undefined;
    if (ui?.["resourceUri"]) {
      qualified["_meta"] = {
        ...meta,
        ui: { ...ui, resourceUri: this.qualifyUri(upstream, String(ui["resourceUri"])) },
      };
    }
    return qualified;
  }

  async #forwardNamed(
    request: Request, key: string, signal?: AbortSignal,
  ): Promise<Response> {
    const params = { ...(request.params ?? {}) } as Record<string, unknown>;
    const qualified = params[key];
    if (typeof qualified !== "string") {
      return {
        jsonrpc: "2.0", id: request.id,
        error: { code: CODE.invalidParams, message: `${request.method} needs a ${key}` },
      };
    }
    const routed = this.route(qualified);
    if (!routed) {
      return {
        jsonrpc: "2.0", id: request.id,
        error: {
          code: CODE.invalidParams,
          message: `No server behind this one owns ${qualified}.`,
        },
      };
    }
    params[key] = routed.local;
    return await this.#forward(routed.upstream, { ...request, params }, signal);
  }

  async #forwardUri(request: Request, signal?: AbortSignal): Promise<Response> {
    const params = { ...(request.params ?? {}) } as Record<string, unknown>;
    const uri = params["uri"];
    if (typeof uri !== "string") {
      return {
        jsonrpc: "2.0", id: request.id,
        error: { code: CODE.invalidParams, message: "resources/read needs a string uri" },
      };
    }
    const routed = this.routeUri(uri);
    if (!routed) {
      return {
        jsonrpc: "2.0", id: request.id,
        error: { code: CODE.invalidParams, message: `Resource not found: ${uri}` },
      };
    }
    params["uri"] = routed.local;
    const answer = await this.#forward(routed.upstream, { ...request, params }, signal);
    // The contents come back naming the upstream's own uri, which is not a uri
    // this gateway's client can ask for a second time.
    if (!isFailure(answer)) {
      const contents = answer.result["contents"] as Array<Record<string, unknown>> | undefined;
      if (contents) {
        answer.result["contents"] = contents.map((content) => ({
          ...content,
          uri: this.qualifyUri(routed.upstream.name, String(content["uri"] ?? "")),
        }));
      }
    }
    return answer;
  }

  async #forward(
    upstream: Upstream, request: Request, signal?: AbortSignal,
  ): Promise<Response> {
    try {
      // The caller's `_meta` goes across untouched. That is the whole trick:
      // the upstream sees the real client's protocol version and capabilities,
      // so a tool that requires one is deciding on the truth rather than on
      // whatever the gateway happens to declare.
      return await upstream.transport.request(request, signal);
    } catch (cause) {
      return {
        jsonrpc: "2.0", id: request.id,
        error: {
          code: CODE.internal,
          message: `${upstream.name} could not be reached: `
            + `${cause instanceof Error ? cause.message : String(cause)}`,
        },
      };
    }
  }
}

/** Build a gateway over several servers. */
export function compose(options: ComposeOptions): Composed {
  return new Composed(options);
}
