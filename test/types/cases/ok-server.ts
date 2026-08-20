// @expect: compiles
import { App } from "../../../src/app.js";
import { contracts, type Deployment } from "./contract.js";

const rows: Deployment[] = [
  { id: "d1", service: "checkout", env: "production", errors: 3 },
];

new App({ name: "demo" }).implement(contracts, {
  list_deployments: async ({ env }) => ({
    deployments: env ? rows.filter((r) => r.env === env) : rows,
  }),
  restart: async ({ id }) => ({ restarted: id.length > 0 }),
});
