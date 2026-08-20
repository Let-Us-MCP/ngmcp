// @expect-error: not assignable
import { App } from "../../../src/app.js";
import { contracts } from "./contract.js";

new App({ name: "demo" }).implement(contracts, {
  // Returns the wrong shape. The contract says { deployments: Deployment[] }.
  list_deployments: async () => ({ rows: [] }),
  restart: async () => ({ restarted: true }),
});
