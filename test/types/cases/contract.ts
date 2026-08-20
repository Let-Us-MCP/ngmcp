/* The shared declaration. Imported by the server, and as a type by the view. */
import { defineTools, type } from "../../../src/contract/define.js";

export interface Deployment {
  id: string;
  service: string;
  env: "production" | "staging" | "canary";
  errors: number;
}

export const contracts = defineTools({
  list_deployments: {
    description: "List deployments.",
    annotations: { readOnlyHint: true },
    view: "ui://demo/table",
    input: type<{ env?: Deployment["env"] }>({
      type: "object", properties: { env: { type: "string" } },
    }),
    output: type<{ deployments: Deployment[] }>(),
  },
  restart: {
    description: "Restart one deployment.",
    input: type<{ id: string }>({
      type: "object", properties: { id: { type: "string" } }, required: ["id"],
    }),
    output: type<{ restarted: boolean }>(),
  },
});
