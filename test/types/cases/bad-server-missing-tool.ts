// @expect-error: not assignable to parameter of type 'Implementation
import { App } from "../../../src/app.js";
import { contracts } from "./contract.js";

// `restart` is declared in the contract and not implemented here.
new App({ name: "demo" }).implement(contracts, {
  list_deployments: async () => ({ deployments: [] }),
});
