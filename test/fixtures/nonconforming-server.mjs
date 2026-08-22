/** A server that gets it wrong, on purpose.
 *
 * Written by hand rather than with `App`, because `App` exists to make these
 * mistakes impossible and the harness has to be shown catching them. Without
 * this fixture, `ngmcp conform` is only ever tested against a server that
 * passes, which proves it can say yes and nothing else.
 *
 * Each violation below is one a real server has plausibly shipped.
 */
import { createInterface } from "node:readline";

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const TOOLS = [
  // inputSchema null: the specification says it MUST be a JSON Schema object.
  { name: "rows", description: "Rows.", inputSchema: null,
    annotations: { readOnlyHint: true } },
  // The same name twice, so a call is ambiguous.
  { name: "rows", description: "Rows again.", inputSchema: { type: "object" } },
  // Names a view the server will not read.
  { name: "chart", description: "Chart.", inputSchema: { type: "object" },
    _meta: { ui: { resourceUri: "ui://broken/never-registered" } } },
];

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    // Swallows a parse error rather than answering -32700.
    return;
  }

  const { id, method } = message;

  // Answers discover, and never enforces `_meta` on anything after it: the
  // context is taken from the connection instead of from the request.
  if (method === "server/discover") {
    write({ jsonrpc: "2.0", id, result: {
      resultType: "complete",
      supportedVersions: ["2026-07-28"],
      capabilities: { tools: {} },
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "broken", version: "0.0.0" } },
    } });
    return;
  }

  if (method === "tools/list") {
    write({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }

  if (method === "resources/read") {
    // -32002 for a missing resource: retired, and forbidden in this version.
    write({ jsonrpc: "2.0", id, error: { code: -32002, message: "Resource not found" } });
    return;
  }

  if (method === "tools/call") {
    // A server-initiated request, which this version removed: input is asked
    // for inside a result now, so that any instance can take the retry.
    write({ jsonrpc: "2.0", id: "srv-1", method: "elicitation/create",
      params: { message: "Who are you?", requestedSchema: { type: "object", properties: {} } } });
    // Progress for a request that supplied no token, inventing a correlation
    // the client cannot use.
    write({ jsonrpc: "2.0", method: "notifications/progress",
      params: { progressToken: "invented", progress: 1, total: 2 } });
    write({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "ok" }] } });
    // And more traffic after the response, for a request already finished with.
    setTimeout(() => write({ jsonrpc: "2.0", method: "notifications/progress",
      params: { progressToken: "invented", progress: 2, total: 2 } }), 50);
    return;
  }

  if (id !== undefined && id !== null) {
    // Answers a method it does not implement, rather than -32601.
    write({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  // Answers a notification, which carries no id to answer.
  write({ jsonrpc: "2.0", id: null, result: {} });
});
