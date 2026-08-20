#!/usr/bin/env node
/* A server used by the integration tests. Real tools, real views, real stdio. */
import { App } from "../../dist/index.js";

const app = new App({
  name: "demo", version: "1.2.3", instructions: "A demo server.",
  concurrency: Number(process.env.DEMO_CONCURRENCY ?? 0),
  defaultTimeoutMs: Number(process.env.DEMO_TIMEOUT_MS ?? 0),
});

app.view("ui://demo/table", { html: "<!doctype html><p id=root>table view</p>" });

app.tool("list_rows", {
  description: "List rows.",
  annotations: { readOnlyHint: true },
  view: "ui://demo/table",
  visibility: ["model", "app"],
  input: { type: "object", properties: { q: { type: "string" } } },
  summary: (out) => `${out.rows.length} rows`,
}, async () => ({ rows: [{ id: "a" }, { id: "b" }, { id: "c" }] }));

app.tool("needs_capability", {
  description: "Needs elicitation.",
  requires: ["elicitation.form"],
}, async () => ({ ok: true }));

app.tool("slow", {
  description: "Reports progress then finishes.",
  input: { type: "object", properties: { ms: { type: "number" } } },
}, async ({ ms = 50 }, ctx) => {
  for (let i = 1; i <= 4; i += 1) {
    if (ctx.signal.aborted) return { done: false };
    ctx.progress(i, 4, `step ${i}`);
    await new Promise((r) => setTimeout(r, ms / 4));
  }
  return { done: true };
});

app.tool("forever", { description: "Runs until cancelled." }, async (_i, ctx) => {
  await new Promise((resolve) => {
    ctx.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  return { stopped: true };
});

app.tool("boom", { description: "Throws." }, async () => {
  throw new Error("the tool failed on purpose");
});

app.tool("echo_required", {
  description: "Requires an id.",
  input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
}, async ({ id }) => ({ id }));

app.tool("chatty", {
  description: "Emits a great many progress notifications as fast as it can.",
  input: { type: "object", properties: { n: { type: "number" } } },
}, async ({ n = 2000 }, ctx) => {
  for (let i = 0; i < n; i += 1) ctx.progress(i, n, `line ${i}`);
  return { emitted: n };
});

app.tool("ignores_cancel", {
  description: "Runs for a fixed time and never looks at its signal.",
  input: { type: "object", properties: { ms: { type: "number" } } },
}, async ({ ms = 400 }) => {
  await new Promise((r) => setTimeout(r, ms));
  return { finished: true };
});

app.tool("concurrent_marker", {
  description: "Reports how many copies of itself were running at once.",
}, async () => {
  globalThis.__active = (globalThis.__active ?? 0) + 1;
  globalThis.__peak = Math.max(globalThis.__peak ?? 0, globalThis.__active);
  await new Promise((r) => setTimeout(r, 80));
  globalThis.__active -= 1;
  return { peak: globalThis.__peak };
});

app.tool("talks_after_returning", {
  description: "Keeps emitting progress after its result has gone out.",
}, async (_i, ctx) => {
  // A handler is free to be wrong. The runtime is not: once the response is
  // written, nothing more may be sent for that request.
  for (let i = 1; i <= 6; i += 1) {
    setTimeout(() => ctx.progress(i, 6, `late ${i}`), i * 25);
  }
  return { returnedImmediately: true };
});

app.resource("file:///demo/notes.txt", { mimeType: "text/plain", text: "hello" });

app.serve();
