import test from "node:test";
import assert from "node:assert/strict";
import { App, compose, localUpstream, httpUpstream } from "../../dist/index.js";

const V = "2026-07-28";
const meta = (over = {}) => ({
  "io.modelcontextprotocol/protocolVersion": V,
  "io.modelcontextprotocol/clientCapabilities": {},
  ...over,
});

const ask = (gateway, method, params = {}, withMeta = meta()) =>
  gateway.handle({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: withMeta } });

/* Composition across servers is the largest thing the extension does not
 * describe. What makes it straightforward here is the same thing everything
 * else rests on: a request carries its own version and capabilities, so
 * forwarding one is copying it. There is no handshake to replay upstream. */

function deploys() {
  const app = new App({ name: "deploys", version: "1.0.0" });
  app.view("ui://app/table", { html: "<!doctype html><p>deployments</p>" });
  app.tool("list", {
    description: "Deployments.", annotations: { readOnlyHint: true },
    view: "ui://app/table",
    summary: (out) => `${out.rows.length} deployments`,
  }, async () => ({ rows: [{ id: "d1", service: "checkout" }] }));
  app.tool("restart", {
    description: "Restart one.",
    requires: ["sampling"],
  }, async (input) => ({ restarted: String(input.id ?? "") }));
  app.prompt("triage", { description: "Triage a deployment." },
    () => [{ role: "user", content: { type: "text", text: "Triage it." } }]);
  return app;
}

function incidents() {
  const app = new App({ name: "incidents", version: "2.0.0" });
  // The same uri as the other server registers. This is the normal case.
  app.view("ui://app/table", { html: "<!doctype html><p>incidents</p>" });
  app.tool("list", {
    description: "Incidents.", annotations: { readOnlyHint: true },
    view: "ui://app/table",
  }, async () => ({ rows: [{ id: "i1", title: "Payments timing out" }] }));
  return app;
}

const both = () => compose({
  name: "operations",
  version: "1.0.0",
  upstreams: [
    { name: "deploys", transport: localUpstream(deploys()) },
    { name: "incidents", transport: localUpstream(incidents()) },
  ],
});

test("one server's tools are all of them, namespaced by where they came from", async () => {
  const answer = await ask(both(), "tools/list");
  assert.deepEqual(answer.result.tools.map((t) => t.name),
    ["deploys.list", "deploys.restart", "incidents.list"]);
  // The descriptions come through untouched: only the name is the gateway's.
  assert.equal(answer.result.tools[0].description, "Deployments.");
});

test("two servers using the same view uri do not collide", async () => {
  /* Both register `ui://app/table`, which is the normal case rather than the
   * unlucky one. A view is fetched by uri, so the uri has to say which server
   * it came from. */
  const gateway = both();
  const listed = await ask(gateway, "tools/list");
  const uris = listed.result.tools
    .filter((t) => t._meta?.ui?.resourceUri)
    .map((t) => t._meta.ui.resourceUri);
  assert.deepEqual(uris, ["ui://deploys/app/table", "ui://incidents/app/table"]);

  const one = await ask(gateway, "resources/read", { uri: "ui://deploys/app/table" });
  assert.match(one.result.contents[0].text, /deployments/);
  const two = await ask(gateway, "resources/read", { uri: "ui://incidents/app/table" });
  assert.match(two.result.contents[0].text, /incidents/);
  // What comes back names a uri the client can ask for again.
  assert.equal(two.result.contents[0].uri, "ui://incidents/app/table");
});

test("a call is routed to the server that owns the tool", async () => {
  const gateway = both();
  const called = await ask(gateway, "tools/call",
    { name: "incidents.list", arguments: {} });
  assert.equal(called.result.structuredContent.rows[0].title, "Payments timing out");

  const other = await ask(gateway, "tools/call", { name: "deploys.list", arguments: {} });
  assert.equal(other.result.structuredContent.rows[0].service, "checkout");
  assert.equal(other.result.content[0].text, "1 deployments");
});

test("the caller's own capabilities travel with the call", async () => {
  /* The upstream decides on the truth about the real client rather than on
   * whatever the gateway happens to declare. Under a session-shaped protocol
   * this would need the gateway to replay a handshake it cannot honestly
   * make. */
  const gateway = both();
  const without = await ask(gateway, "tools/call",
    { name: "deploys.restart", arguments: { id: "d1" } });
  assert.equal(without.error.code, -32021,
    "the upstream did not see the real client's capabilities");

  const with_ = await ask(gateway, "tools/call",
    { name: "deploys.restart", arguments: { id: "d1" } },
    meta({ "io.modelcontextprotocol/clientCapabilities": { sampling: {} } }));
  assert.equal(with_.result.structuredContent.restarted, "d1");
});

test("prompts compose the same way tools do", async () => {
  const gateway = both();
  const listed = await ask(gateway, "prompts/list");
  assert.deepEqual(listed.result.prompts.map((p) => p.name), ["deploys.triage"]);
  const got = await ask(gateway, "prompts/get", { name: "deploys.triage" });
  assert.equal(got.result.messages[0].content.text, "Triage it.");
});

test("a tool nothing behind the gateway owns is refused clearly", async () => {
  const gateway = both();
  const missing = await ask(gateway, "tools/call", { name: "billing.refund", arguments: {} });
  assert.equal(missing.error.code, -32602);
  assert.match(missing.error.message, /No server behind this one owns/);

  const unqualified = await ask(gateway, "tools/call", { name: "list", arguments: {} });
  assert.equal(unqualified.error.code, -32602);
});

test("one upstream being down is one upstream missing, not a failed board", async () => {
  /* A composition that is only as available as its least available member is
   * worse than its parts. */
  const gateway = compose({
    name: "operations",
    upstreams: [
      { name: "deploys", transport: localUpstream(deploys()) },
      {
        name: "incidents",
        transport: { request: async () => { throw new Error("ECONNREFUSED"); } },
      },
    ],
  });
  const listed = await ask(gateway, "tools/list");
  assert.deepEqual(listed.result.tools.map((t) => t.name), ["deploys.list", "deploys.restart"]);
  // An empty list and a list that could not be got are different things.
  assert.deepEqual(listed.result._meta["ngmcp/unreachable"],
    [{ name: "incidents", reason: "ECONNREFUSED" }]);

  // And the half that is up still answers.
  const called = await ask(gateway, "tools/call", { name: "deploys.list", arguments: {} });
  assert.equal(called.result.structuredContent.rows.length, 1);
});

test("a call to an upstream that is down fails as that call, with its name", async () => {
  const gateway = compose({
    name: "operations",
    upstreams: [{
      name: "incidents",
      transport: { request: async () => { throw new Error("ECONNREFUSED"); } },
    }],
  });
  const called = await ask(gateway, "tools/call", { name: "incidents.list", arguments: {} });
  assert.equal(called.error.code, -32603);
  assert.match(called.error.message, /incidents could not be reached/);
});

test("discovery says what it is made of", async () => {
  const found = await ask(both(), "server/discover");
  assert.deepEqual(found.result.supportedVersions, [V]);
  assert.equal(found.result._meta["io.modelcontextprotocol/serverInfo"].name, "operations");
  assert.deepEqual(
    found.result._meta["ngmcp/composedOf"].map((u) => u.name),
    ["deploys", "incidents"]);
});

test("composition works across a real network boundary", async () => {
  /* The upstream here is a separate process's worth of protocol over HTTP:
   * one request, one response, nothing kept between them. */
  const remote = await incidents().serveHttp({ port: 0 });
  try {
    const gateway = compose({
      name: "operations",
      upstreams: [
        { name: "deploys", transport: localUpstream(deploys()) },
        { name: "incidents", transport: httpUpstream(`http://127.0.0.1:${remote.port}/`) },
      ],
    });
    const listed = await ask(gateway, "tools/list");
    assert.deepEqual(listed.result.tools.map((t) => t.name),
      ["deploys.list", "deploys.restart", "incidents.list"]);
    const called = await ask(gateway, "tools/call", { name: "incidents.list", arguments: {} });
    assert.equal(called.result.structuredContent.rows[0].id, "i1");
    const view = await ask(gateway, "resources/read", { uri: "ui://incidents/app/table" });
    assert.match(view.result.contents[0].text, /incidents/);
  } finally { await remote.close(); }
});

test("two gateways over the same servers answer identically", async () => {
  /* Nothing is remembered about a caller anywhere in the chain, so a second
   * gateway that has never spoken to anyone answers the same. */
  const one = await ask(both(), "tools/call", { name: "deploys.list", arguments: {} });
  const two = await ask(both(), "tools/call", { name: "deploys.list", arguments: {} });
  assert.deepEqual(one.result, two.result);
});

test("an upstream whose name contains the separator is refused at construction", async () => {
  assert.throws(() => compose({
    name: "operations",
    upstreams: [{ name: "ops.deploys", transport: localUpstream(deploys()) }],
  }), /could be routed back/);
});

test("a cancellation reaches whichever upstream is running the call", async () => {
  /* The gateway does not remember which upstream is running what, because
   * remembering that would be the session. So it tells all of them. */
  const told = [];
  const gateway = compose({
    name: "operations",
    upstreams: ["a", "b"].map((name) => ({
      name,
      transport: {
        async request(message) {
          told.push({ name, method: message.method });
          return { jsonrpc: "2.0", id: message.id ?? 0, result: {} };
        },
      },
    })),
  });
  const answer = await gateway.handle({
    jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 },
  });
  assert.equal(answer, null, "a notification was answered");
  assert.deepEqual(told, [
    { name: "a", method: "notifications/cancelled" },
    { name: "b", method: "notifications/cancelled" },
  ]);
});
