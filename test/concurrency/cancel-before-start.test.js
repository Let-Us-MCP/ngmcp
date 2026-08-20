import test from "node:test";
import assert from "node:assert/strict";
import { connect, settle } from "../helpers/client.mjs";

/* A cancellation can arrive before the handler has run at all: validating the
 * arguments and waiting for a concurrency slot both yield to the event loop.
 * Running the handler anyway hands it a signal that has already fired, and the
 * ordinary way to wait for cancellation,
 *
 *     await new Promise((r) => ctx.signal.addEventListener("abort", r));
 *
 * then waits for an event in the past. The request never answers and never
 * ends. This reproduced about half the time before the check that fixes it,
 * which is why it is here with a repeat count rather than a single run. */

test("a request cancelled before its handler starts still answers", async () => {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const c = connect();
    try {
      const doomed = c.requestWithId("tools/call", { name: "forever", arguments: {} });
      // A second call in flight is what widens the window enough to see it.
      const healthy = c.request("tools/call", { name: "slow", arguments: { ms: 150 } });
      await settle(1);
      c.notify("notifications/cancelled", { requestId: doomed.id });

      const answered = await Promise.race([
        doomed.promise,
        settle(2500).then(() => "hung"),
      ]);
      assert.notEqual(answered, "hung",
        `attempt ${attempt}: a cancelled request never answered`);
      assert.notEqual(answered.error, undefined,
        `attempt ${attempt}: a cancelled request must not report success`);
      await healthy;
    } finally {
      await c.close();
    }
  }
});

test("a server that lost a request to this race still answers new ones", async () => {
  const c = connect();
  try {
    const doomed = c.requestWithId("tools/call", { name: "forever", arguments: {} });
    c.request("tools/call", { name: "slow", arguments: { ms: 120 } });
    await settle(1);
    c.notify("notifications/cancelled", { requestId: doomed.id });
    await Promise.race([doomed.promise, settle(2000)]);
    const later = await c.request("tools/list");
    assert.equal(later.error, undefined);
    assert.ok(later.result.tools.length > 0);
  } finally {
    await c.close();
  }
});
