#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { App } from "../../dist/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DEPLOYMENTS = [
  { id: "d1", service: "checkout", env: "production", status: "healthy" },
  { id: "d2", service: "billing", env: "production", status: "degraded" },
  { id: "d3", service: "search", env: "staging", status: "healthy" },
  { id: "d4", service: "notifications", env: "canary", status: "healthy" },
];

const app = new App({ name: "data-explorer", version: "1.0.0" });

app.view("ui://data-explorer/table", {
  html: readFileSync(path.join(HERE, "view.html"), "utf8"),
});

app.tool("list_deployments", {
  description: "List recent deployments with their environment and status.",
  annotations: { readOnlyHint: true },
  view: "ui://data-explorer/table",
  visibility: ["model", "app"],
  input: { type: "object", properties: { env: { type: "string" } } },
  // The rows go to the view. The model gets this sentence, and nothing else.
  summary: (out) => {
    const bad = out.deployments.filter((d) => d.status !== "healthy");
    return bad.length
      ? `${out.deployments.length} deployments, ${bad.length} not healthy: `
        + bad.map((d) => d.service).join(", ")
      : `${out.deployments.length} deployments, all healthy`;
  },
}, async ({ env }) => ({
  deployments: env ? DEPLOYMENTS.filter((d) => d.env === env) : DEPLOYMENTS,
}));

app.serve();
