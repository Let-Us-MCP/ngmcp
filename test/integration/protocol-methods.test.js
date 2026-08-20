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

/* Elicitation: the server asks the person, through the client. */

test("a tool asks the person a question and gets their answer back", async () => {
  const c = connect({
    answer: (message) => {
      if (message.method !== "elicitation/create") return undefined;
      return { result: { action: "accept", content: { reason: "Rolling back the deploy" } } };
    },
  });
  try {
    const called = await c.request("tools/call",
      { name: "restart", arguments: { id: "d1" } },
      meta({ "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } } }));
    assert.equal(called.result.structuredContent.reason, "Rolling back the deploy");
    assert.equal(called.result.structuredContent.action, "accept");

    const asked = c.asked.find((m) => m.method === "elicitation/create");
    assert.equal(asked.params.mode, "form");
    assert.match(asked.params.message, /Why/);
    assert.equal(asked.params.requestedSchema.type, "object");
    assert.deepEqual(asked.params.requestedSchema.required, ["reason"]);
    // The server minted the id, and it cannot be mistaken for a client's.
    assert.match(String(asked.id), /^srv-/);
  } finally { await c.close(); }
});

test("declining is the person's answer and reaches the handler as one", async () => {
  const c = connect({
    answer: (message) => message.method === "elicitation/create"
      ? { result: { action: "decline" } } : undefined,
  });
  try {
    const called = await c.request("tools/call",
      { name: "restart", arguments: { id: "d1" } },
      meta({ "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } } }));
    assert.equal(called.result.structuredContent.action, "decline");
    assert.equal(called.result.structuredContent.restarted, false);
  } finally { await c.close(); }
});

test("dismissing without choosing is not the same as saying no", async () => {
  /* Cancel is a person who walked away; decline is a person who decided.
   * Recording the first as the second puts a refusal in the record that
   * nobody made. */
  const c = connect({
    answer: (message) => message.method === "elicitation/create"
      ? { result: { action: "cancel" } } : undefined,
  });
  try {
    const called = await c.request("tools/call",
      { name: "restart", arguments: { id: "d1" } },
      meta({ "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } } }));
    assert.equal(called.result.structuredContent.action, "cancel");
    assert.equal(called.result.structuredContent.restarted, false);
  } finally { await c.close(); }
});

test("a cancelled call does not leave its question waiting forever", async () => {
  /* This is the line between an in-flight request and a session. A question
   * that outlives the request that asked it is state the next request could
   * find, which is the thing this server does not have. */
  const c = connect({ answer: () => undefined });
  try {
    const call = c.send("tools/call",
      { name: "restart", arguments: { id: "d1" } },
      meta({ "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } } }));
    // Wait until the server has actually asked, so the cancellation lands
    // while the question is outstanding rather than before it was sent.
    for (let i = 0; i < 50 && !c.asked.some((m) => m.method === "elicitation/create"); i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(c.asked.some((m) => m.method === "elicitation/create"));
    c.write({
      jsonrpc: "2.0", method: "notifications/cancelled",
      params: { requestId: call.id },
    });
    const answered = await Promise.race([
      call.settled.then(() => "answered"),
      new Promise((r) => setTimeout(() => r("still waiting"), 2000)),
    ]);
    assert.equal(answered, "answered",
      "the tool call is still waiting for an answer nobody is going to send");
  } finally { await c.close(); }
});

test("a client that never offered elicitation is not asked", async () => {
  /* Absent is not refused. A handler usually wants a different answer for a
   * client that has no way to ask anybody than for a person who said no. */
  const c = connect({
    answer: (message) => message.method === "elicitation/create"
      ? { result: { action: "accept", content: {} } } : undefined,
  });
  try {
    const called = await c.request("tools/call", { name: "restart", arguments: { id: "d1" } });
    assert.equal(called.result.structuredContent.action, "unavailable");
    assert.equal(c.asked.filter((m) => m.method === "elicitation/create").length, 0,
      "the server asked a client that never offered elicitation");
  } finally { await c.close(); }
});

/* Sampling: the server asks the client's model. */

test("a tool asks the client's model and gets a completion", async () => {
  const c = connect({
    answer: (message) => message.method === "sampling/createMessage"
      ? {
          result: {
            model: "claude-opus-5", role: "assistant", stopReason: "endTurn",
            content: { type: "text", text: "Checkout is failing on payment timeouts." },
          },
        }
      : undefined,
  });
  try {
    const called = await c.request("tools/call",
      { name: "summarise", arguments: {} },
      meta({ "io.modelcontextprotocol/clientCapabilities": { sampling: {} } }));
    assert.equal(called.result.structuredContent.ok, true);
    assert.equal(called.result.structuredContent.model, "claude-opus-5");
    assert.match(called.result.structuredContent.text, /payment timeouts/);

    const asked = c.asked.find((m) => m.method === "sampling/createMessage");
    assert.equal(asked.params.messages[0].role, "user");
    assert.equal(asked.params.maxTokens, 200);
  } finally { await c.close(); }
});

test("a client that refuses to sample is told apart from one that cannot", async () => {
  const c = connect({
    answer: (message) => message.method === "sampling/createMessage"
      ? { error: { code: -32000, message: "The user declined sampling." } } : undefined,
  });
  try {
    const refused = await c.request("tools/call",
      { name: "summarise", arguments: {} },
      meta({ "io.modelcontextprotocol/clientCapabilities": { sampling: {} } }));
    assert.equal(refused.result.structuredContent.ok, false);
    assert.equal(refused.result.structuredContent.reason, "refused");
    assert.match(refused.result.structuredContent.detail, /declined/);

    const absent = await c.request("tools/call", { name: "summarise", arguments: {} });
    assert.equal(absent.result.structuredContent.reason, "absent");
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

test("elicitation over a transport with no way back is unavailable, not a hang", async () => {
  const app = new App({ name: "no-way-back", version: "1.0.0" });
  app.tool("ask", { description: "Asks." }, async (_input, ctx) =>
    ctx.elicit({
      message: "Why?",
      requestedSchema: { type: "object", properties: { reason: { type: "string" } } },
    }));
  const answer = await app.handle({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: {
      name: "ask", arguments: {},
      _meta: meta({ "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } } }),
    },
  });
  assert.equal(answer.result.structuredContent.action, "unavailable");
  assert.match(answer.result.structuredContent.reason, /no way back/);
});
