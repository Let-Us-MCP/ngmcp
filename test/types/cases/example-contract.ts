/** The shared declaration. The server implements it; the view calls it.
 *
 * This file is the only place the shape of a deployment is written down. The
 * server imports it for its values, the view imports it as a type, and a
 * change here stops both compiling until both agree.
 */
import { defineTools, type } from "../../../src/index.js";

export interface Deployment {
  id: string;
  service: string;
  env: "production" | "staging" | "canary";
  errors: number;
}

export const contracts = defineTools({
  list_deployments: {
    description: "List deployments with their environment and error counts.",
    annotations: { readOnlyHint: true },
    view: "ui://data-explorer/table",
    visibility: ["model", "app"],
    input: type<{ env?: Deployment["env"] }>({
      type: "object",
      properties: { env: { type: "string", enum: ["production", "staging", "canary"] } },
    }),
    output: type<{ deployments: Deployment[] }>(),
    // The rows go to the view. The model gets this and nothing else.
    summary: (out: { deployments: Deployment[] }) => {
      const bad = out.deployments.filter((d) => d.errors > 0);
      return bad.length
        ? `${out.deployments.length} deployments, ${bad.length} with errors: `
          + bad.map((d) => d.service).join(", ")
        : `${out.deployments.length} deployments, none with errors`;
    },
  },
  restart: {
    description: "Restart one deployment.",
    input: type<{ id: string }>({
      type: "object", properties: { id: { type: "string" } }, required: ["id"],
    }),
    output: type<{ restarted: boolean; service: string }>(),
    summary: (out: { restarted: boolean; service: string }) =>
      `Restarted ${out.service}.`,
  },
});
