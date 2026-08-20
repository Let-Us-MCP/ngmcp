/** The server half. It implements the contract and serves the view.
 *
 * `implement` is checked against the shared declaration, so adding a tool to
 * `contract.ts` stops this file compiling until it is written.
 *
 * The view is read from a file built beside this one. Nothing can be fetched
 * inside a `ui://` frame, so the whole view is inlined at build time by
 * `bundleView`, and the server only has to hand it over.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { App, UserError } from "../../src/index.js";
import { contracts, type Deployment } from "./contract.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const ROWS: Deployment[] = [
  { id: "d1", service: "checkout", env: "production", errors: 143 },
  { id: "d2", service: "billing", env: "production", errors: 12 },
  { id: "d3", service: "search", env: "staging", errors: 0 },
  { id: "d4", service: "notifications", env: "canary", errors: 7 },
];

const html = readFileSync(path.join(HERE, "view.html"), "utf8");

const app = new App({ name: "data-explorer", version: "1.0.0" });
app.view("ui://data-explorer/table", { html });

app.implement(contracts, {
  list_deployments: async ({ env }) => ({
    deployments: env ? ROWS.filter((row) => row.env === env) : ROWS,
  }),
  restart: async ({ id }) => {
    const row = ROWS.find((r) => r.id === id);
    if (!row) throw new UserError(`No deployment ${id}.`);
    return { restarted: true, service: row.service };
  },
});

app.serve();
