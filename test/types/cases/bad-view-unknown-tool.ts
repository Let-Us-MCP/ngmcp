// @expect-error: does not exist on type
import { client, fakeBridge } from "../../../src/view/client.js";
import type { contracts } from "./contract.js";

const api = client<typeof contracts>({ bridge: fakeBridge({}) });

export async function render(): Promise<unknown> {
  // Not in the contract at all.
  return api.delete_everything({});
}
