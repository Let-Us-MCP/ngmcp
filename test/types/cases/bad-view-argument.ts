// @expect-error: not assignable
import { client, fakeBridge } from "../../../src/view/client.js";
import type { contracts } from "./contract.js";

const api = client<typeof contracts>({ bridge: fakeBridge({}) });

export async function render(): Promise<boolean> {
  // `env` is a union of three literals; "development" is not one of them.
  const { deployments } = await api.list_deployments({ env: "development" });
  return deployments.length > 0;
}
