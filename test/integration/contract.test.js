import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { client } from "../../dist/view/client.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "fixtures", "contract-server.mjs");
const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};

/** A bridge over a real server, so the typed client is exercised against the
 *  wire rather than a stub. */
function connect() {
  const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
  const waiters = new Map();
  let buffer = "", id = 0;
  child.stderr.resume();
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      if (waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
    }
  });
  const bridge = {
    callServerTool(name, args) {
      return new Promise((resolve) => {
        const rid = ++id;
        waiters.set(rid, (m) => resolve(m.result ?? {
          isError: true, content: [{ type: "text", text: m.error?.message ?? "failed" }],
        }));
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: rid,
          method: "tools/call", params: { name, arguments: args, _meta: META } })}\n`);
      });
    },
  };
  return {
    bridge,
    async close() {
      try { child.stdin.end(); } catch { /* gone */ }
      child.kill("SIGKILL");
      for (const s of [child.stdin, child.stdout, child.stderr]) { try { s?.destroy(); } catch {} }
      child.unref();
    },
  };
}

test("a view calls a contract tool and gets the declared shape back", async () => {
  const c = connect();
  try {
    const api = client({ bridge: c.bridge });
    const result = await api.list_deployments({});
    assert.equal(result.deployments.length, 4);
    assert.equal(result.deployments[0].service, "checkout");
  } finally { await c.close(); }
});

test("arguments reach the server through the typed call", async () => {
  const c = connect();
  try {
    const api = client({ bridge: c.bridge });
    const result = await api.list_deployments({ env: "production" });
    assert.equal(result.deployments.length, 2);
    for (const d of result.deployments) assert.equal(d.env, "production");
  } finally { await c.close(); }
});

test("the sentence for the model is separate from the data for the view", async () => {
  const c = connect();
  try {
    const seen = [];
    const api = client({ bridge: c.bridge, onText: (tool, text) => seen.push([tool, text]) });
    const result = await api.list_deployments({});
    assert.equal(seen.length, 1);
    assert.equal(seen[0][0], "list_deployments");
    assert.match(seen[0][1], /4 deployments/);
    assert.ok(!seen[0][1].includes("checkout,"), "the model was handed the rows");
    assert.equal(result.deployments.length, 4, "the view got them instead");
  } finally { await c.close(); }
});

test("a failing tool raises rather than returning a shape the view will misread", async () => {
  const c = connect();
  try {
    const api = client({ bridge: c.bridge });
    await assert.rejects(() => api.restart({ id: "nope" }), (error) => {
      assert.equal(error.name, "ToolError");
      assert.equal(error.tool, "restart");
      assert.match(error.message, /No deployment/);
      return true;
    });
  } finally { await c.close(); }
});

test("every tool the contract declares is registered on the server", async () => {
  const c = connect();
  try {
    const api = client({ bridge: c.bridge });
    const ok = await api.restart({ id: "d1" });
    assert.equal(ok.restarted, true);
  } finally { await c.close(); }
});
