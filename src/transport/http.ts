/** The same server, over HTTP.
 *
 * This file is short because of the decision made everywhere else. There are
 * no sessions to key, no `Mcp-Session-Id` to mint or expire, no state to
 * share between instances, and no sticky routing to arrange. A request
 * carries its own protocol version and capabilities, so any process holding
 * the registry can answer any request. That is what makes one `App` able to
 * serve stdio, a Node server and a serverless invocation without behaving
 * differently.
 *
 * `2026-07-28` removed the HTTP GET endpoint along with sessions, so there is
 * no stream to open here. Request-scoped notifications belong on the response
 * of the request that caused them, which for a plain JSON response means they
 * are dropped rather than misattributed.
 */
import type { Dispatcher } from "../runtime/dispatch.js";
import type { Incoming } from "../protocol/jsonrpc.js";
import { CODE } from "../protocol/errors.js";

export interface HttpHandlerOptions {
  /** Rejects bodies larger than this. Zero means no limit. */
  maxBodyBytes?: number;
  /** Answers `GET` on this path with 200. Empty disables it. */
  healthPath?: string;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const rpcError = (code: number, message: string, id: string | number | null = null) =>
  ({ jsonrpc: "2.0" as const, id, error: { code, message } });

/** A handler in the shape every modern runtime understands.
 *
 * Works unchanged on Node's `fetch` server, Workers, Deno and Bun, because it
 * takes a `Request` and returns a `Response` and holds nothing in between.
 */
export function httpHandler(
  dispatcher: Dispatcher,
  options: HttpHandlerOptions = {},
): (request: Request) => Promise<Response> {
  const { maxBodyBytes = 4 * 1024 * 1024, healthPath = "/health" } = options;

  return async function handle(request: Request): Promise<Response> {
    if (healthPath && request.method === "GET"
        && new URL(request.url).pathname === healthPath) {
      return new Response("ok", { status: 200 });
    }
    if (request.method !== "POST") {
      // No GET endpoint exists in this version: it went with sessions.
      return json(405, rpcError(CODE.invalidRequest, "Use POST."));
    }

    const declared = Number(request.headers.get("content-length") ?? "0");
    if (maxBodyBytes > 0 && declared > maxBodyBytes) {
      return json(413, rpcError(CODE.invalidRequest, "Body too large."));
    }

    let text: string;
    try {
      text = await request.text();
    } catch {
      return json(400, rpcError(CODE.parse, "Could not read the body."));
    }
    if (maxBodyBytes > 0 && text.length > maxBodyBytes) {
      return json(413, rpcError(CODE.invalidRequest, "Body too large."));
    }

    let message: Incoming | Incoming[];
    try {
      message = JSON.parse(text) as Incoming | Incoming[];
    } catch (error) {
      return json(400, rpcError(CODE.parse, (error as Error).message));
    }

    // A batch is answered in parallel, which costs nothing to allow because
    // the requests share no state with each other.
    if (Array.isArray(message)) {
      const answers = (await Promise.all(message.map((m) => dispatcher.handle(m))))
        .filter((r) => r !== null);
      return answers.length ? json(200, answers) : new Response(null, { status: 202 });
    }

    const response = await dispatcher.handle(message);
    if (!response) return new Response(null, { status: 202 });
    // A protocol-level refusal is still a well-formed answer, so the status
    // stays 200 and the error lives in the body, as JSON-RPC intends. The one
    // exception the specification names is a malformed request, which is a
    // 400 on HTTP.
    const status = "error" in response
      && response.error.code === CODE.invalidParams ? 400 : 200;
    return json(status, response);
  };
}

/** Serve over HTTP with Node's built-in server. */
export async function serveHttp(
  dispatcher: Dispatcher,
  options: HttpHandlerOptions & { port?: number; hostname?: string } = {},
): Promise<{ port: number; close(): Promise<void> }> {
  const { createServer } = await import("node:http");
  const handler = httpHandler(dispatcher, options);

  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const url = `http://${incoming.headers.host ?? "localhost"}${incoming.url ?? "/"}`;
      const request = new Request(url, {
        method: incoming.method,
        headers: incoming.headers as Record<string, string>,
        ...(incoming.method === "POST"
          ? { body: Buffer.concat(chunks).toString() } : {}),
      });
      void handler(request).then(async (response) => {
        outgoing.statusCode = response.status;
        response.headers.forEach((value, key) => outgoing.setHeader(key, value));
        outgoing.end(response.body ? await response.text() : undefined);
      });
    });
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(options.port ?? 0, options.hostname ?? "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });

  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
