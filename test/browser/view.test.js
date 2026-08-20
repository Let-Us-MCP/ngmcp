import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openApp } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "..", "examples", "data-explorer", "dist", "server.mjs");
const ENGINES = (process.env.NGMCP_ENGINES ?? "chromium,webkit").split(",");

/* The example, end to end: a real server, the view it delivers, the contract
 * between them, and the components doing the drawing. Everything below is the
 * shipped example rather than a fixture written for the test. */

for (const engine of ENGINES) {
  const at = (n) => `[${engine}] ${n}`;

  test(at("the view draws what the server returned"), async () => {
    const app = await openApp(engine, SERVER);
    try {
      await app.frame.locator(".data-table tbody tr").first().waitFor();
      assert.equal(await app.frame.locator(".data-table tbody tr").count(), 4);
      assert.match(await app.frame.locator(".data-table tbody tr").first().textContent(), /checkout/);
    } finally { await app.close(); }
  });

  test(at("the metrics are computed from the same rows"), async () => {
    const app = await openApp(engine, SERVER);
    try {
      await app.frame.locator(".data-table tbody tr").first().waitFor();
      const numbers = await app.frame.locator(".metric-number").allTextContents();
      assert.deepEqual(numbers, ["4", "3"], "four deployments, three with errors");
    } finally { await app.close(); }
  });

  test(at("the frame is opaque, so the host cannot read it"), async () => {
    const app = await openApp(engine, SERVER);
    try {
      const reachable = await app.page.evaluate(() => {
        try {
          const win = document.getElementById("view").contentWindow;
          return win.document !== null && win.document !== undefined;
        } catch { return false; }
      });
      assert.equal(reachable, false, "page script read into an opaque-origin frame");
    } finally { await app.close(); }
  });

  test(at("filtering costs no tool call"), async () => {
    const app = await openApp(engine, SERVER);
    try {
      await app.frame.locator(".data-table tbody tr").first().waitFor();
      const before = (await app.calls()).length;
      await app.frame.locator(".filter").fill("bill");
      await app.frame.locator(".status").filter({ hasText: "1 of 4" }).waitFor();
      assert.equal((await app.calls()).length, before,
        "a local filter must not cross the boundary");
    } finally { await app.close(); }
  });

  test(at("selecting a row enables the operation that needs one"), async () => {
    const app = await openApp(engine, SERVER);
    try {
      await app.frame.locator(".data-table tbody tr").first().waitFor();
      const restart = app.frame.locator(".card-actions .btn").first();
      assert.equal(await restart.isDisabled(), true);
      await app.frame.locator(".data-table tbody tr").first().click();
      await restart.filter({ hasNotText: "__never__" }).waitFor();
      assert.equal(await restart.isDisabled(), false);
    } finally { await app.close(); }
  });

  test(at("the operation calls the server and reports what came back"), async () => {
    const app = await openApp(engine, SERVER);
    try {
      await app.frame.locator(".data-table tbody tr").first().waitFor();
      await app.frame.locator(".data-table tbody tr").first().click();
      const before = (await app.calls()).length;
      await app.frame.locator(".card-actions .btn").first().click();
      await app.frame.locator(".toast").waitFor({ timeout: 8000 });
      assert.match(await app.frame.locator(".toast-text").textContent(), /Restarted checkout/);
      assert.equal((await app.calls()).length, before + 1, "one call, for one operation");
    } finally { await app.close(); }
  });

  test(at("a row selects from the keyboard alone"), async () => {
    const app = await openApp(engine, SERVER);
    try {
      const row = app.frame.locator(".data-table tbody tr").nth(1);
      await row.waitFor();
      await row.focus();
      await app.page.keyboard.press("Enter");
      const selected = app.frame.locator('.data-table tbody tr[aria-selected="true"]');
      assert.equal(await selected.count(), 1);
      assert.match(await selected.textContent(), /billing/);
    } finally { await app.close(); }
  });
}
