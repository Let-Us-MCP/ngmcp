import test from "node:test";
import assert from "node:assert/strict";
import { App, serveHttp, type as t } from "../../dist/index.js";

const V = "2026-07-28";
const meta = (over = {}) => ({
  "io.modelcontextprotocol/protocolVersion": V,
  "io.modelcontextprotocol/clientCapabilities": {},
  ...over,
});

function build() {
  const app = new App({ name: "http-demo", version: "2.0.0" });
  app.view("ui://http/table", { html: "<!doctype html><p>view</p>" });
  app.tool("rows", {
    description: "Rows.", annotations: { readOnlyHint: true },
    view: "ui://http/table",
    summary: (out) => `${out.rows.length} rows`,
  }, async () => ({ rows: [{ id: "a" }, { id: "b" }] }));
  return app;
}

const post = (base, body) => fetch(base, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const withServer = async (fn) => {
  const app = build();
  const server = await app.serveHttp({ port: 0 });
  const base = `http://127.0.0.1:${server.port}/`;
  try { await fn(base, app); } finally { await server.close(); }
};

test("the same App answers over HTTP with no session anywhere", async () => {
  await withServer(async (base) => {
    const response = await post(base, {
      jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: meta() },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.result.supportedVersions, [V]);
    assert.equal(response.headers.get("mcp-session-id"), null,
      "a session id appeared, which this version removed");
  });
});

test("tools and resources work the same as over stdio", async () => {
  await withServer(async (base) => {
    const listed = await (await post(base, {
      jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta() },
    })).json();
    assert.equal(listed.result.tools[0]._meta.ui.resourceUri, "ui://http/table");

    const called = await (await post(base, {
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "rows", arguments: {}, _meta: meta() },
    })).json();
    assert.equal(called.result.structuredContent.rows.length, 2);
    assert.equal(called.result.content[0].text, "2 rows");
  });
});

test("a request missing its _meta is a 400, as the specification says on HTTP", async () => {
  await withServer(async (base) => {
    const response = await post(base, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, -32602);
  });
});

test("an older protocol version is refused with -32022", async () => {
  await withServer(async (base) => {
    const response = await post(base, {
      jsonrpc: "2.0", id: 1, method: "tools/list",
      params: { _meta: meta({ "io.modelcontextprotocol/protocolVersion": "2025-11-25" }) },
    });
    // The refusal is a well-formed answer, so it travels as one: 200 with the
    // error in the body, which is what JSON-RPC intends. A transport status
    // here would tell a proxy to retry something that can never succeed, and
    // would hide the `supported` list behind an error page.
    assert.equal(response.status, 200, "a protocol refusal became a transport failure");
    const body = await response.json();
    assert.equal(body.error.code, -32022);
    assert.deepEqual(body.error.data.supported, [V]);
  });
});

test("there is no GET endpoint, because it went with sessions", async () => {
  await withServer(async (base) => {
    const response = await fetch(base, { method: "GET" });
    assert.equal(response.status, 405);
  });
});

test("health answers, so a load balancer has something to ask", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}health`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
  });
});

test("a batch is answered in one response", async () => {
  await withServer(async (base) => {
    const body = await (await post(base, [
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta() } },
      { jsonrpc: "2.0", id: 2, method: "server/discover", params: { _meta: meta() } },
    ])).json();
    assert.ok(Array.isArray(body));
    assert.equal(body.length, 2);
    assert.deepEqual(body.map((r) => r.id).sort(), [1, 2]);
  });
});

test("a notification gets 202 and no body", async () => {
  await withServer(async (base) => {
    const response = await post(base, {
      jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 99 },
    });
    assert.equal(response.status, 202);
  });
});

test("malformed JSON is a parse error, not a crash", async () => {
  await withServer(async (base) => {
    const response = await fetch(base, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{not json",
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, -32700);
  });
});

test("two servers on different ports answer identically, needing nothing shared", async () => {
  const one = await build().serveHttp({ port: 0 });
  const two = await build().serveHttp({ port: 0 });
  try {
    const ask = (port) => post(`http://127.0.0.1:${port}/`, {
      jsonrpc: "2.0", id: 7, method: "tools/call",
      params: { name: "rows", arguments: {}, _meta: meta() },
    }).then((r) => r.json());
    // The same request answered by two processes that have never spoken. This
    // is what statelessness buys, and it is why there is no sticky routing.
    const [a, b] = await Promise.all([ask(one.port), ask(two.port)]);
    assert.deepEqual(a.result, b.result);
  } finally {
    await one.close(); await two.close();
  }
});

test("the same App serves stdio and HTTP without behaving differently", async () => {
  const app = build();
  const server = await app.serveHttp({ port: 0 });
  try {
    const overHttp = await (await post(`http://127.0.0.1:${server.port}/`, {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "rows", arguments: {}, _meta: meta() },
    })).json();
    // The same object, asked directly, with no transport at all.
    const direct = await app.handle({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "rows", arguments: {}, _meta: meta() },
    });
    assert.deepEqual(overHttp.result, direct.result);
  } finally { await server.close(); }
});
