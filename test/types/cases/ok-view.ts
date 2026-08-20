// @expect: compiles
import { client, fakeBridge } from "../../../src/view/client.js";
import type { contracts } from "./contract.js";

const api = client<typeof contracts>({ bridge: fakeBridge({}) });

export async function render(): Promise<string> {
  // No `?.`, no `?? []`: the shape is known.
  const { deployments } = await api.list_deployments({ env: "production" });
  const { restarted } = await api.restart({ id: deployments[0]!.id });
  return `${deployments.length} deployments, restarted=${restarted}`;
}
