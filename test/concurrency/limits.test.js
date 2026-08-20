import test from "node:test";
import assert from "node:assert/strict";
import { connect, settle } from "../helpers/client.mjs";
import { spawn } from "node:child_process";
import { SERVER } from "../helpers/client.mjs";

test("a concurrency limit is a queue, not a rejection: every call still answers", async () => {
  const client = connect();
  try {
    const answers = await Promise.all(Array.from({ length: 8 }, () =>
      client.request("tools/call", { name: "concurrent_marker", arguments: {} })));
    assert.equal(answers.length, 8, "every queued call answered");
    for (const a of answers) assert.equal(a.error, undefined);
  } finally { await client.close(); }
});

test("with a limit of 2, no more than 2 tools run at once", async () => {
  const child = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, DEMO_CONCURRENCY: "2" },
  });
  const waiters = new Map();
  let buffer = "", id = 0;
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
  const meta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  const call = () => new Promise((resolve) => {
    const rid = ++id;
    waiters.set(rid, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: rid,
      method: "tools/call", params: { name: "concurrent_marker", arguments: {}, _meta: meta } })}\n`);
  });
  try {
    const answers = await Promise.all(Array.from({ length: 6 }, call));
    const peak = Math.max(...answers.map((a) => a.result.structuredContent.peak));
    assert.equal(answers.length, 6);
    assert.ok(peak <= 2, `peak concurrency was ${peak}, expected at most 2`);
  } finally {
    child.stdin.end(); child.kill("SIGKILL");
    for (const s of [child.stdin, child.stdout, child.stderr]) { try { s?.destroy(); } catch {} }
    child.unref();
  }
});

test("a tool that overruns its timeout is aborted and answers with an error", async () => {
  const child = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, DEMO_TIMEOUT_MS: "120" },
  });
  const waiters = new Map();
  let buffer = "", id = 0;
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
  const meta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  const call = (name, args) => new Promise((resolve) => {
    const rid = ++id;
    waiters.set(rid, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: rid,
      method: "tools/call", params: { name, arguments: args, _meta: meta } })}\n`);
  });
  try {
    const slow = await call("ignores_cancel", { ms: 600 });
    assert.notEqual(slow.error, undefined, "a tool past its timeout must not report success");
    assert.match(slow.error.message, /timeout/);
    // The server is still usable afterwards.
    const quick = await call("ignores_cancel", { ms: 10 });
    assert.equal(quick.result.structuredContent.finished, true);
  } finally {
    child.stdin.end(); child.kill("SIGKILL");
    for (const s of [child.stdin, child.stdout, child.stderr]) { try { s?.destroy(); } catch {} }
    child.unref();
  }
});

test("a flood of progress is thinned rather than queued without bound", async () => {
  const client = connect();
  try {
    const answer = await client.request("tools/call",
      { name: "chatty", arguments: { n: 4000 } }, { progressToken: "flood" });
    assert.equal(answer.result.structuredContent.emitted, 4000);
    await settle(120);
    const seen = client.notifications.filter(
      (n) => n.params?.progressToken === "flood").length;
    assert.ok(seen > 0, "some progress must still arrive");
    assert.ok(seen < 4000,
      `every one of 4000 notifications was queued (${seen}); pressure must thin them`);
  } finally { await client.close(); }
});

test("thinned progress still arrives in order, never replaying a stale value", async () => {
  const client = connect();
  try {
    await client.request("tools/call",
      { name: "chatty", arguments: { n: 3000 } }, { progressToken: "order" });
    await settle(150);
    const values = client.notifications
      .filter((n) => n.params?.progressToken === "order")
      .map((n) => n.params.progress);
    assert.ok(values.length > 1, "some progress must arrive");
    for (let i = 1; i < values.length; i += 1) {
      assert.ok(values[i] > values[i - 1],
        `progress went backwards: ${values[i - 1]} then ${values[i]}`);
    }
    // Whatever was still coalesced when the response went out is dropped
    // rather than sent afterwards, because a message after the response is
    // one the client can no longer attribute to a running request.
    assert.ok(values[values.length - 1] < 3000,
      "the queued tail must be dropped, not flushed after the response");
  } finally { await client.close(); }
});
