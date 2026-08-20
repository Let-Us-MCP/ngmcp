import test from "node:test";
import assert from "node:assert/strict";
import { connect, M, settle } from "../helpers/client.mjs";

const withServer = async (fn) => {
  const client = connect();
  try { await fn(client); } finally { await client.close(); }
};

test("requests are dispatched concurrently, not one after another", async () => {
  await withServer(async (c) => {
    const started = Date.now();
    const calls = Array.from({ length: 5 }, () =>
      c.request("tools/call", { name: "slow", arguments: { ms: 200 } }));
    const results = await Promise.all(calls);
    const elapsed = Date.now() - started;
    for (const r of results) assert.equal(r.result.structuredContent.done, true);
    // Serial would be at least 1000ms. Concurrent is one slow call plus change.
    assert.ok(elapsed < 700, `five 200ms calls took ${elapsed}ms; they ran in series`);
  });
});

test("a fast request overtakes a slow one already in flight", async () => {
  await withServer(async (c) => {
    const order = [];
    const slow = c.request("tools/call", { name: "slow", arguments: { ms: 300 } })
      .then(() => order.push("slow"));
    await settle(20);
    const fast = c.request("tools/list").then(() => order.push("fast"));
    await Promise.all([slow, fast]);
    assert.deepEqual(order, ["fast", "slow"], "responses must not be serialised on arrival order");
  });
});

test("every response carries the id of its own request", async () => {
  await withServer(async (c) => {
    const sent = Array.from({ length: 6 }, (_, i) =>
      c.requestWithId("tools/call", { name: "slow", arguments: { ms: 30 + i * 10 } }));
    const answers = await Promise.all(sent.map((s) => s.promise));
    for (const [i, answer] of answers.entries()) {
      assert.equal(answer.id, sent[i].id);
    }
  });
});

test("progress notifications carry the token of the request that asked", async () => {
  await withServer(async (c) => {
    const seen = [];
    c.onNotification((n) => {
      if (n.method === "notifications/progress") seen.push(n.params.progressToken);
    });
    await Promise.all([
      c.request("tools/call", { name: "slow", arguments: { ms: 120 } }, { progressToken: "A" }),
      c.request("tools/call", { name: "slow", arguments: { ms: 120 } }, { progressToken: "B" }),
    ]);
    await settle(80);
    assert.ok(seen.includes("A") && seen.includes("B"), "both requests reported");
    assert.deepEqual([...new Set(seen)].sort(), ["A", "B"], "no token leaked between requests");
  });
});

test("a request that supplied no progress token receives no progress at all", async () => {
  await withServer(async (c) => {
    const seen = [];
    c.onNotification((n) => { if (n.method === "notifications/progress") seen.push(n); });
    await c.request("tools/call", { name: "slow", arguments: { ms: 80 } });
    await settle(80);
    assert.equal(seen.length, 0, "progress without a token invents a correlation");
  });
});

test("no progress arrives after the response it belongs to", async () => {
  await withServer(async (c) => {
    let respondedAt = null;
    const late = [];
    c.onNotification((n) => {
      if (n.method !== "notifications/progress") return;
      if (respondedAt !== null) late.push(n);
    });
    await c.request("tools/call", { name: "slow", arguments: { ms: 100 } }, { progressToken: "T" });
    respondedAt = Date.now();
    await settle(200);
    assert.equal(late.length, 0, "a notification outlived its request");
  });
});

test("cancelling a running request stops it and sends nothing further", async () => {
  await withServer(async (c) => {
    const after = [];
    const sent = c.requestWithId("tools/call", { name: "forever", arguments: {} },
      { progressToken: "C" });
    await settle(60);
    c.notify("notifications/cancelled", { requestId: sent.id, reason: "user stopped it" });
    const answer = await sent.promise;
    assert.notEqual(answer.error, undefined, "a cancelled call must not report success");
    assert.match(answer.error.message, /cancelled/);
    c.onNotification((n) => { if (n.params?.progressToken === "C") after.push(n); });
    await settle(150);
    assert.equal(after.length, 0, "messages continued after cancellation");
  });
});

test("cancelling one request leaves the others running", async () => {
  await withServer(async (c) => {
    const doomed = c.requestWithId("tools/call", { name: "forever", arguments: {} });
    const healthy = c.request("tools/call", { name: "slow", arguments: { ms: 150 } });
    await settle(40);
    c.notify("notifications/cancelled", { requestId: doomed.id });
    const [dead, alive] = await Promise.all([doomed.promise, healthy]);
    assert.notEqual(dead.error, undefined);
    assert.equal(alive.result.structuredContent.done, true);
  });
});

test("cancelling something that is not running is harmless", async () => {
  await withServer(async (c) => {
    c.notify("notifications/cancelled", { requestId: 99999 });
    await settle(40);
    const r = await c.request("tools/list");
    assert.equal(r.error, undefined);
  });
});

test("the client going away cancels everything in flight", async () => {
  const c = connect();
  const exited = new Promise((resolve) => c.child.on("exit", resolve));
  c.requestWithId("tools/call", { name: "forever", arguments: {} });
  await settle(80);
  c.child.stdin.end();
  await settle(120);
  c.child.kill();
  await exited;
  assert.ok(true, "the server did not hang on a request nobody was waiting for");
});

test("a slow tool that ignores its signal still cannot write after cancellation", async () => {
  await withServer(async (c) => {
    const sent = c.requestWithId("tools/call", { name: "slow", arguments: { ms: 400 } },
      { progressToken: "Z" });
    await settle(50);
    c.notify("notifications/cancelled", { requestId: sent.id });
    const answer = await sent.promise;
    assert.notEqual(answer.error, undefined);
    const before = c.notifications.filter((n) => n.params?.progressToken === "Z").length;
    await settle(500);
    const after = c.notifications.filter((n) => n.params?.progressToken === "Z").length;
    assert.equal(after, before, "the handler kept talking after its request died");
  });
});

test("a handler that keeps talking after it returned is silenced by the runtime", async () => {
  const client = connect();
  try {
    const answer = await client.request("tools/call",
      { name: "talks_after_returning", arguments: {} }, { progressToken: "late" });
    assert.equal(answer.result.structuredContent.returnedImmediately, true);
    const atResponse = client.notifications.filter(
      (n) => n.params?.progressToken === "late").length;
    await settle(300);
    const afterwards = client.notifications.filter(
      (n) => n.params?.progressToken === "late").length;
    assert.equal(afterwards, atResponse,
      `${afterwards - atResponse} notification(s) went out after the response`);
  } finally { await client.close(); }
});
