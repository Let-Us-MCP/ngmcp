import test from "node:test";
import assert from "node:assert/strict";
import { connect, M, VERSION, settle } from "../helpers/client.mjs";

const withServer = async (fn) => {
  const client = connect();
  try { await fn(client); } finally { await client.close(); }
};

test("server/discover answers before anything is negotiated", async () => {
  await withServer(async (c) => {
    const r = await c.request("server/discover");
    assert.deepEqual(r.result.supportedVersions, [VERSION]);
    assert.equal(r.result.resultType, "complete");
    assert.equal(r.result._meta[M.serverInfo].name, "demo");
    assert.equal(r.result._meta[M.serverInfo].version, "1.2.3");
    assert.equal(r.result.instructions, "A demo server.");
  });
});

test("server/discover advertises the MCP Apps extension with its mime type", async () => {
  await withServer(async (c) => {
    const r = await c.request("server/discover");
    const ui = r.result.capabilities.extensions["io.modelcontextprotocol/ui"];
    assert.deepEqual(ui.mimeTypes, ["text/html;profile=mcp-app"]);
  });
});

test("server/discover answers a client on an older version, so it can negotiate", async () => {
  await withServer(async (c) => {
    const r = await c.request("server/discover", {}, { [M.protocolVersion]: "2025-11-25" });
    assert.equal(r.error, undefined);
    assert.deepEqual(r.result.supportedVersions, [VERSION]);
  });
});

test("every other method refuses an older version with -32022 and names what it speaks", async () => {
  await withServer(async (c) => {
    for (const method of ["tools/list", "resources/list", "tools/call"]) {
      const r = await c.request(method, { name: "list_rows" }, { [M.protocolVersion]: "2025-11-25" });
      assert.equal(r.error.code, -32022, `${method} should refuse`);
      assert.deepEqual(r.error.data.supported, [VERSION]);
      assert.equal(r.error.data.requested, "2025-11-25");
    }
  });
});

test("a request with no _meta is rejected with -32602 naming both fields", async () => {
  await withServer(async (c) => {
    const r = await c.request("tools/list", {}, {}, null);
    assert.equal(r.error.code, -32602);
    assert.equal(r.error.data.missing.length, 2);
  });
});

test("there is no initialize, and asking for one is a method-not-found", async () => {
  await withServer(async (c) => {
    const r = await c.request("initialize", { protocolVersion: VERSION });
    assert.equal(r.error.code, -32601);
  });
});

test("tools/list carries the view uri and visibility on every tool that has one", async () => {
  await withServer(async (c) => {
    const r = await c.request("tools/list");
    const tool = r.result.tools.find((t) => t.name === "list_rows");
    assert.equal(tool._meta.ui.resourceUri, "ui://demo/table");
    assert.deepEqual(tool._meta.ui.visibility, ["model", "app"]);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(typeof tool.inputSchema, "object");
    assert.notEqual(tool.inputSchema, null);
  });
});

test("the view is readable and comes back as an MCP App with a csp", async () => {
  await withServer(async (c) => {
    const r = await c.request("resources/read", { uri: "ui://demo/table" });
    const content = r.result.contents[0];
    assert.equal(content.mimeType, "text/html;profile=mcp-app");
    assert.match(content.text, /table view/);
    assert.deepEqual(content._meta.ui.csp, {});
  });
});

test("a missing resource errors, and never with the retired -32002", async () => {
  await withServer(async (c) => {
    const r = await c.request("resources/read", { uri: "file:///nope" });
    assert.notEqual(r.error, undefined);
    assert.notEqual(r.error.code, -32002, "-32002 is forbidden in 2026-07-28");
    assert.equal(r.error.code, -32602);
    assert.equal(r.result, undefined, "a missing resource must not return contents");
  });
});

test("a tool call returns data to the view and one sentence to the model", async () => {
  await withServer(async (c) => {
    const r = await c.request("tools/call", { name: "list_rows", arguments: {} });
    assert.equal(r.result.structuredContent.rows.length, 3);
    assert.equal(r.result.content[0].text, "3 rows");
    assert.equal(r.result.content.length, 1, "the model gets a sentence, not the rows");
  });
});

test("a tool needing a capability the client did not declare fails with -32021", async () => {
  await withServer(async (c) => {
    const r = await c.request("tools/call", { name: "needs_capability", arguments: {} });
    assert.equal(r.error.code, -32021);
    assert.deepEqual(r.error.data.requiredCapabilities, ["elicitation.form"]);
  });
});

test("the same tool succeeds once the client declares the capability", async () => {
  await withServer(async (c) => {
    const r = await c.request("tools/call", { name: "needs_capability", arguments: {} },
      { [M.clientCapabilities]: { elicitation: { form: {} } } });
    assert.equal(r.error, undefined);
    assert.equal(r.result.structuredContent.ok, true);
  });
});

test("a required argument that is missing is rejected before the handler runs", async () => {
  await withServer(async (c) => {
    const r = await c.request("tools/call", { name: "echo_required", arguments: {} });
    assert.equal(r.error.code, -32602);
    assert.deepEqual(r.error.data.missing, ["id"]);
  });
});

test("a throwing tool reports isError rather than killing the connection", async () => {
  await withServer(async (c) => {
    const r = await c.request("tools/call", { name: "boom", arguments: {} });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /on purpose/);
    const after = await c.request("tools/list");
    assert.ok(after.result.tools.length > 0, "the server still answers");
  });
});

test("an unknown tool and an unknown method are both refused, distinctly", async () => {
  await withServer(async (c) => {
    const tool = await c.request("tools/call", { name: "nope", arguments: {} });
    assert.equal(tool.error.code, -32602);
    const method = await c.request("does/not/exist");
    assert.equal(method.error.code, -32601);
  });
});

test("a malformed line gets a parse error and the server keeps serving", async () => {
  await withServer(async (c) => {
    c.raw("{not json");
    await settle();
    assert.ok(c.notifications.some((n) => n.error?.code === -32700));
    const r = await c.request("tools/list");
    assert.equal(r.error, undefined);
  });
});

test("resources/list includes the view and any plain resources", async () => {
  await withServer(async (c) => {
    const r = await c.request("resources/list");
    const uris = r.result.resources.map((x) => x.uri);
    assert.ok(uris.includes("ui://demo/table"));
    assert.ok(uris.includes("file:///demo/notes.txt"));
  });
});
