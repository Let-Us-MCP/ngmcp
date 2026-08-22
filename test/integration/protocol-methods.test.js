import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { App } from "../../dist/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "fixtures", "asking-server.mjs");

const V = "2026-07-28";
const meta = (over = {}) => ({
  "io.modelcontextprotocol/protocolVersion": V,
  "io.modelcontextprotocol/clientCapabilities": {},
  ...over,
});

/* The four things that were named as absent. Prompts are ordinary and
 * server-side. Elicitation and sampling invert the direction, which needs a
 * transport with a way back and an honest answer where there is none.
 * `subscriptions/listen` is a request that does not answer until it is torn
 * down, which is what makes it an in-flight request rather than a session. */

/** A client over a real pipe that can also answer what the server asks it. */
function connect({ answer } = {}) {
  const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
  const waiters = new Map();
  const notifications = [];
  const asked = [];
  const noteWaiters = [];
  let buffer = "", id = 0;
  child.stderr.resume();

  const write = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.method && message.id !== undefined) {
        // The server is asking us something.
        asked.push(message);
        const reply = answer?.(message);
        if (reply !== undefined) write({ jsonrpc: "2.0", id: message.id, ...reply });
        continue;
      }
      if (message.method) {
        notifications.push(message);
        for (const waiter of noteWaiters.splice(0)) waiter();
        continue;
      }
      const waiter = waiters.get(message.id);
      if (waiter) { waiters.delete(message.id); waiter(message); }
    }
  });

  const request = (method, params = {}, withMeta = meta()) => new Promise((resolve) => {
    const rid = ++id;
    waiters.set(rid, resolve);
    write({ jsonrpc: "2.0", id: rid, method, params: { ...params, _meta: withMeta } });
    return rid;
  });

  const send = (method, params = {}, withMeta = meta()) => {
    const rid = ++id;
    const settled = new Promise((resolve) => waiters.set(rid, resolve));
    write({ jsonrpc: "2.0", id: rid, method, params: { ...params, _meta: withMeta } });
    return { id: rid, settled };
  };

  const untilNotification = async (predicate, tries = 50) => {
    for (let i = 0; i < tries; i += 1) {
      const found = notifications.find(predicate);
      if (found) return found;
      await new Promise((r) => { noteWaiters.push(r); setTimeout(r, 20); });
    }
    return undefined;
  };

  return {
    request, send, write, notifications, asked, untilNotification,
    async close() {
      try { child.stdin.end(); } catch { /* gone */ }
      child.kill("SIGKILL");
      for (const s of [child.stdin, child.stdout, child.stderr]) {
        try { s?.destroy(); } catch { /* gone */ }
      }
      child.unref();
    },
  };
}

/* Prompts. */

test("a server lists the prompts it offers, with their arguments", async () => {
  const c = connect();
  try {
    const listed = await c.request("prompts/list");
    assert.deepEqual(listed.result.prompts.map((p) => p.name), ["triage", "postmortem"]);
    const triage = listed.result.prompts[0];
    assert.equal(triage.description, "Work through an incident in order.");
    assert.deepEqual(triage.arguments, [
      { name: "service", description: "Which service is failing.", required: true },
      { name: "since", description: "How far back to look.", required: false },
    ]);
  } finally { await c.close(); }
});

test("prompts/get fills a prompt in from its arguments", async () => {
  const c = connect();
  try {
    const got = await c.request("prompts/get", {
      name: "triage", arguments: { service: "checkout", since: "an hour" },
    });
    assert.equal(got.result.description, "Work through an incident in order.");
    assert.equal(got.result.messages.length, 2);
    assert.equal(got.result.messages[0].role, "user");
    assert.match(got.result.messages[0].content.text, /checkout/);
    assert.match(got.result.messages[0].content.text, /an hour/);
  } finally { await c.close(); }
});

test("a prompt that does not exist is -32602, not the retired code", async () => {
  const c = connect();
  try {
    const got = await c.request("prompts/get", { name: "nope" });
    assert.equal(got.error.code, -32602);
    assert.match(got.error.message, /Unknown prompt/);
  } finally { await c.close(); }
});

test("the prompts capability is declared only by a server that has prompts", async () => {
  const c = connect();
  try {
    const found = await c.request("server/discover");
    assert.deepEqual(found.result.capabilities.prompts, { listChanged: true });
  } finally { await c.close(); }

  const bare = new App({ name: "bare", version: "1.0.0" });
  bare.tool("noop", { description: "Nothing." }, async () => ({}));
  const answer = await bare.handle({
    jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: meta() },
  });
  assert.equal(answer.result.capabilities.prompts, undefined,
    "a server with no prompts claimed it can tell a client when they change");
});

/* Elicitation and sampling, under Multi Round-Trip Requests.
 *
 * `2026-07-28` deleted server-initiated requests: a server no longer sends
 * `elicitation/create` down the wire and waits. It answers `input_required`
 * saying what it needs, and the client retries the same request with the
 * answers attached. The specification's reason is this package's reason —
 * it works "without requiring a shared storage layer across server instances
 * or requiring stateful load balancing". */

const ELICIT_CAPS = meta({
  "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
});
const SAMPLE_CAPS = meta({
  "io.modelcontextprotocol/clientCapabilities": { sampling: {} },
});

test("a tool that needs input says so, rather than asking down the wire", async () => {
  const c = connect();
  try {
    const first = await c.request("tools/call",
      { name: "restart", arguments: { id: "d1" } }, ELICIT_CAPS);

    assert.equal(first.result.resultType, "input_required");
    const asked = first.result.inputRequests;
    assert.deepEqual(Object.keys(asked), ["why"]);
    assert.equal(asked.why.method, "elicitation/create");
    assert.equal(asked.why.params.mode, "form");
    assert.match(asked.why.params.message, /Why/);
    assert.deepEqual(asked.why.params.requestedSchema.required, ["reason"]);

    // Nothing was sent to the client as a request of its own.
    assert.equal(c.asked.length, 0,
      "the server sent a server-initiated request, which this version removed");

    // And nothing happened yet: the handler stops before it changes anything.
    assert.equal(first.result.structuredContent, undefined);
  } finally { await c.close(); }
});

test("the retry carries the answer and the same request completes", async () => {
  const c = connect();
  try {
    const first = await c.request("tools/call",
      { name: "restart", arguments: { id: "d1" } }, ELICIT_CAPS);
    assert.equal(first.result.resultType, "input_required");

    // The same request again, with what the client gathered.
    const second = await c.request("tools/call", {
      name: "restart",
      arguments: { id: "d1" },
      inputResponses: {
        why: { action: "accept", content: { reason: "Rolling back the deploy" } },
      },
    }, ELICIT_CAPS);

    assert.equal(second.result.structuredContent.action, "accept");
    assert.equal(second.result.structuredContent.restarted, true);
    assert.equal(second.result.structuredContent.reason, "Rolling back the deploy");
  } finally { await c.close(); }
});

test("any instance can answer the retry, which is the whole point", async () => {
  /* The round trip carries everything needed, so the retry does not have to
   * reach the process that asked. Two servers that have never spoken: one
   * raises the request, a different one completes it. */
  const first = connect();
  const second = connect();
  try {
    const asked = await first.request("tools/call",
      { name: "restart", arguments: { id: "d1" } }, ELICIT_CAPS);
    assert.equal(asked.result.resultType, "input_required");

    const finished = await second.request("tools/call", {
      name: "restart",
      arguments: { id: "d1" },
      inputResponses: { why: { action: "accept", content: { reason: "Rolled back" } } },
    }, ELICIT_CAPS);

    assert.equal(finished.result.structuredContent.restarted, true,
      "a second instance could not finish what the first one started");
  } finally { await first.close(); await second.close(); }
});

test("declining is the person's answer and reaches the handler as one", async () => {
  const c = connect();
  try {
    const answered = await c.request("tools/call", {
      name: "restart", arguments: { id: "d1" },
      inputResponses: { why: { action: "decline" } },
    }, ELICIT_CAPS);
    assert.equal(answered.result.structuredContent.action, "decline");
    assert.equal(answered.result.structuredContent.restarted, false);
  } finally { await c.close(); }
});

test("dismissing without choosing is not the same as saying no", async () => {
  const c = connect();
  try {
    const answered = await c.request("tools/call", {
      name: "restart", arguments: { id: "d1" },
      inputResponses: { why: { action: "cancel" } },
    }, ELICIT_CAPS);
    assert.equal(answered.result.structuredContent.action, "cancel");
    assert.equal(answered.result.structuredContent.restarted, false);
  } finally { await c.close(); }
});

test("a client that never offered elicitation is not asked to go and get it", async () => {
  /* Absent is not refused, and it is not a round trip either: asking a client
   * with no way to put the question to anybody would loop forever. */
  const c = connect();
  try {
    const answered = await c.request("tools/call", { name: "restart", arguments: { id: "d1" } });
    assert.equal(answered.result.resultType, undefined,
      "the server asked a client that cannot ask anybody");
    assert.equal(answered.result.structuredContent.action, "unavailable");
  } finally { await c.close(); }
});

test("sampling takes the same round trip", async () => {
  const c = connect();
  try {
    const first = await c.request("tools/call",
      { name: "summarise", arguments: {} }, SAMPLE_CAPS);
    assert.equal(first.result.resultType, "input_required");
    assert.equal(first.result.inputRequests.summary.method, "sampling/createMessage");
    assert.equal(first.result.inputRequests.summary.params.maxTokens, 200);

    const second = await c.request("tools/call", {
      name: "summarise", arguments: {},
      inputResponses: {
        summary: {
          model: "claude-opus-5", role: "assistant", stopReason: "endTurn",
          content: { type: "text", text: "Checkout is failing on payment timeouts." },
        },
      },
    }, SAMPLE_CAPS);
    assert.equal(second.result.structuredContent.ok, true);
    assert.equal(second.result.structuredContent.model, "claude-opus-5");
    assert.match(second.result.structuredContent.text, /payment timeouts/);
  } finally { await c.close(); }
});

test("a client that cannot sample is told apart from one that will not", async () => {
  const c = connect();
  try {
    const absent = await c.request("tools/call", { name: "summarise", arguments: {} });
    assert.equal(absent.result.structuredContent.ok, false);
    assert.equal(absent.result.structuredContent.reason, "absent");
  } finally { await c.close(); }
});

test("two things are asked for in one round trip, not two", async () => {
  const c = connect();
  try {
    const first = await c.request("tools/call",
      { name: "both_at_once", arguments: {} },
      meta({ "io.modelcontextprotocol/clientCapabilities":
        { elicitation: { form: {} }, sampling: {} } }));
    assert.equal(first.result.resultType, "input_required");
    assert.deepEqual(Object.keys(first.result.inputRequests).sort(), ["summary", "who"]);

    const second = await c.request("tools/call", {
      name: "both_at_once", arguments: {},
      inputResponses: {
        who: { action: "accept", content: { name: "Sam" } },
        summary: { content: { type: "text", text: "All quiet." } },
      },
    }, meta({ "io.modelcontextprotocol/clientCapabilities":
      { elicitation: { form: {} }, sampling: {} } }));
    assert.equal(second.result.structuredContent.who, "Sam");
    assert.equal(second.result.structuredContent.summary, "All quiet.");
  } finally { await c.close(); }
});

test("a partial answer asks only for what is still missing", async () => {
  const c = connect();
  try {
    const partial = await c.request("tools/call", {
      name: "both_at_once", arguments: {},
      inputResponses: { who: { action: "accept", content: { name: "Sam" } } },
    }, meta({ "io.modelcontextprotocol/clientCapabilities":
      { elicitation: { form: {} }, sampling: {} } }));
    assert.equal(partial.result.resultType, "input_required");
    assert.deepEqual(Object.keys(partial.result.inputRequests), ["summary"],
      "the client was asked again for something it had already answered");
  } finally { await c.close(); }
});

/* subscriptions/listen: the stream that replaced the GET endpoint. */

test("a subscription is acknowledged before anything else on it", async () => {
  const c = connect();
  try {
    const stream = c.send("subscriptions/listen", {
      notifications: { resourcesListChanged: true, resourceSubscriptions: ["ui://gallery/rows"] },
    });
    const ack = await c.untilNotification(
      (n) => n.method === "notifications/subscriptions/acknowledged");
    assert.ok(ack, "the subscription was never acknowledged");
    assert.equal(ack.params._meta["io.modelcontextprotocol/subscriptionId"], stream.id);
    assert.deepEqual(ack.params.notifications, {
      resourcesListChanged: true, resourceSubscriptions: ["ui://gallery/rows"],
    });
    // The stream is open: the request it came from has not been answered.
    const raced = await Promise.race([
      stream.settled.then(() => "answered"),
      new Promise((r) => setTimeout(() => r("still open"), 200)),
    ]);
    assert.equal(raced, "still open", "a listen stream answered immediately");
  } finally { await c.close(); }
});

test("the acknowledgement reports only what the server can honour", async () => {
  const c = connect();
  try {
    c.send("subscriptions/listen", {
      notifications: {
        toolsListChanged: true,
        promptsListChanged: true,
        // Asked for by name and named nothing: not a subscription to
        // everything, and not a subscription at all.
        resourceSubscriptions: [],
      },
    });
    const ack = await c.untilNotification(
      (n) => n.method === "notifications/subscriptions/acknowledged");
    assert.deepEqual(ack.params.notifications,
      { toolsListChanged: true, promptsListChanged: true },
      "the server agreed to something it was not asked to do");
  } finally { await c.close(); }
});

test("a notification the client did not ask for is not sent", async () => {
  /* The filter is an allow list. A server that sends more than was asked for
   * produces traffic the client cannot attribute to anything. */
  const c = connect();
  try {
    c.send("subscriptions/listen", { notifications: { toolsListChanged: true } });
    await c.untilNotification((n) => n.method === "notifications/subscriptions/acknowledged");
    // The fixture changes a resource and the tool list on demand.
    await c.request("tools/call", { name: "stir", arguments: {} });
    const toolsChanged = await c.untilNotification(
      (n) => n.method === "notifications/tools/list_changed");
    assert.ok(toolsChanged, "the notification that was asked for never arrived");
    assert.equal(
      c.notifications.filter((n) => n.method === "notifications/resources/updated").length, 0,
      "a resource update reached a client that never subscribed to it");
  } finally { await c.close(); }
});

test("a resource update reaches only the uris that were named", async () => {
  const c = connect();
  try {
    const stream = c.send("subscriptions/listen", {
      notifications: { resourceSubscriptions: ["res://rows"] },
    });
    await c.untilNotification((n) => n.method === "notifications/subscriptions/acknowledged");
    await c.request("tools/call", { name: "stir", arguments: {} });
    const updated = await c.untilNotification(
      (n) => n.method === "notifications/resources/updated");
    assert.ok(updated, "the subscribed resource never reported a change");
    assert.equal(updated.params.uri, "res://rows");
    assert.equal(updated.params._meta["io.modelcontextprotocol/subscriptionId"], stream.id,
      "the notification is not tagged with the subscription that asked for it");
    assert.equal(
      c.notifications.filter((n) => n.method === "notifications/resources/updated"
        && n.params.uri === "res://other").length, 0,
      "an unnamed resource was reported");
  } finally { await c.close(); }
});

test("cancelling a subscription closes the stream and answers the request", async () => {
  const c = connect();
  try {
    const stream = c.send("subscriptions/listen", { notifications: { toolsListChanged: true } });
    await c.untilNotification((n) => n.method === "notifications/subscriptions/acknowledged");
    c.write({
      jsonrpc: "2.0", method: "notifications/cancelled",
      params: { requestId: stream.id },
    });
    const answer = await stream.settled;
    // The response the client has been holding all along is what closes it.
    assert.equal(answer.id, stream.id);
    assert.equal(
      answer.result._meta["io.modelcontextprotocol/subscriptionId"], stream.id);
  } finally { await c.close(); }
});

test("a transport with no stream says so rather than leaving a client waiting", async () => {
  /* Over a plain HTTP response there is no channel left to carry a stream, and
   * a client holding a request that will never speak is worse than being
   * told. */
  const app = new App({ name: "no-stream", version: "1.0.0" });
  app.tool("noop", { description: "Nothing." }, async () => ({}));
  const answer = await app.handle({
    jsonrpc: "2.0", id: 1, method: "subscriptions/listen",
    params: { notifications: { toolsListChanged: true }, _meta: meta() },
  });
  assert.equal(answer.error.code, -32600);
  assert.match(answer.error.message, /no notification stream/);
});

test("elicitation works over a transport with no way back at all", async () => {
  /* This test used to assert the opposite, and asserting the opposite was
   * right for the pattern it was written against: a server-initiated request
   * needs a channel back, and a single HTTP response has none.
   *
   * The round trip removes the need. Nothing is sent to the client except a
   * result, and the client returns with the answer on an ordinary request. So
   * elicitation now works on a transport that can only ever answer, which is
   * the whole reason the specification changed it. */
  const app = new App({ name: "no-way-back", version: "1.0.0" });
  app.tool("ask", { description: "Asks." }, async (_input, ctx) => {
    const answer = await ctx.elicit("why", {
      message: "Why?",
      requestedSchema: { type: "object", properties: { reason: { type: "string" } } },
    });
    return { action: answer.action, ...(answer.action === "accept" ? answer.content : {}) };
  });

  const caps = meta({
    "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
  });

  const asked = await app.handle({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "ask", arguments: {}, _meta: caps },
  });
  assert.equal(asked.result.resultType, "input_required");
  assert.equal(asked.result.inputRequests.why.method, "elicitation/create");

  const finished = await app.handle({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: {
      name: "ask", arguments: {},
      inputResponses: { why: { action: "accept", content: { reason: "because" } } },
      _meta: caps,
    },
  });
  assert.equal(finished.result.structuredContent.action, "accept");
  assert.equal(finished.result.structuredContent.reason, "because");
});
