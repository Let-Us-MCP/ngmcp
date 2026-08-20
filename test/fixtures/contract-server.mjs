#!/usr/bin/env node
/* A server built from the shared contract, the way the README describes. */
import { App, defineTools, type, UserError } from "../../dist/index.js";

export const contracts = defineTools({
  list_deployments: {
    description: "List deployments with their environment and status.",
    annotations: { readOnlyHint: true },
    view: "ui://demo/table",
    input: type({ type: "object", properties: { env: { type: "string" } } }),
    output: type(),
    summary: (out) => out.deployments.length + " deployments, " + out.deployments.filter((d) => d.errors > 0).length + " with errors",
  },
  restart: {
    description: "Restart one deployment.",
    input: type({ type: "object", properties: { id: { type: "string" } }, required: ["id"] }),
    output: type(),
  },
});

const ROWS = [
  { id: "d1", service: "checkout", env: "production", errors: 143 },
  { id: "d2", service: "billing", env: "production", errors: 12 },
  { id: "d3", service: "search", env: "staging", errors: 0 },
  { id: "d4", service: "notifications", env: "canary", errors: 7 },
];

const app = new App({ name: "contract-demo", version: "1.0.0" });
app.view("ui://demo/table", { html: "<!doctype html><p id=root>table</p>" });

app.implement(contracts, {
  list_deployments: async ({ env }) => ({
    deployments: env ? ROWS.filter((r) => r.env === env) : ROWS,
  }),
  restart: async ({ id }) => {
    if (!ROWS.some((r) => r.id === id)) throw new UserError(`No deployment ${id}.`);
    return { restarted: true };
  },
});

app.serve();
