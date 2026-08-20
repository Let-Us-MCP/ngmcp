// @expect-error: does not exist on type
import { client, fakeBridge } from "../../../src/view/client.js";
import type { contracts } from "./contract.js";

const api = client<typeof contracts>({ bridge: fakeBridge({}) });

export async function render(): Promise<number> {
  const result = await api.list_deployments({});
  // The contract calls it `deployments`, not `rows`.
  return result.rows.length;
}
