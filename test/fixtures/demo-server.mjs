#!/usr/bin/env node
/* A server used by the integration tests. Real tools, real views, real stdio. */
import { App } from "../../dist/index.js";

const app = new App({ name: "demo", version: "1.2.3", instructions: "A demo server." });

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

app.resource("file:///demo/notes.txt", { mimeType: "text/plain", text: "hello" });

app.serve();
