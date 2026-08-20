import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openApp } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "..", "examples", "data-explorer", "server.mjs");
const ENGINES = (process.env.NGMCP_ENGINES ?? "chromium,webkit").split(",");

/* Both engines run the same assertions. A view is HTML in a sandboxed frame,
 * and the two engines disagree about enough of that surface to be worth
 * running twice: focus, dialog, safe-area insets and clipboard all differ. */

for (const engine of ENGINES) {
  test(`[${engine}] the view renders rows the server actually returned`, async () => {
    const app = await openApp(engine, SERVER);
    try {
      await app.frame.locator("#rows tr").first().waitFor();
      assert.equal(await app.frame.locator("#rows tr").count(), 4);
      assert.equal(await app.frame.locator("#count").textContent(), "4 of 4 shown");
      assert.match(await app.frame.locator("#rows tr").first().textContent(), /checkout/);
      assert.equal(await app.frame.locator("#error").isVisible(), false);
    } finally { await app.close(); }
  });

  test(`[${engine}] the frame really is opaque, so the host cannot read it`, async () => {
    const app = await openApp(engine, SERVER);
    try {
      // If this ever starts succeeding, the sandbox has been weakened and
      // every security claim the view makes is void.
      const reachable = await app.page.evaluate(() => {
        try {
          const win = document.getElementById("view").contentWindow;
          return win.document !== null && win.document !== undefined;
        } catch { return false; }
      });
      assert.equal(reachable, false, "page script read into an opaque-origin frame");
    } finally { await app.close(); }
  });

  test(`[${engine}] filtering is local and costs no tool call`, async () => {
    const app = await openApp(engine, SERVER);
    try {
      await app.frame.locator("#rows tr").first().waitFor();
      const before = (await app.calls()).length;
      await app.frame.locator("#q").fill("bill");
      await app.frame.locator("#count").filter({ hasText: "1 of 4" }).waitFor();
      assert.equal(await app.frame.locator("#rows tr").count(), 1);
      assert.equal((await app.calls()).length, before,
        "a local filter must not cross the boundary");
    } finally { await app.close(); }
  });

  test(`[${engine}] clearing the filter restores every row, still locally`, async () => {
    const app = await openApp(engine, SERVER);
    try {
      await app.frame.locator("#rows tr").first().waitFor();
      await app.frame.locator("#q").fill("search");
      await app.frame.locator("#count").filter({ hasText: "1 of 4" }).waitFor();
      await app.frame.locator("#q").fill("");
      await app.frame.locator("#count").filter({ hasText: "4 of 4" }).waitFor();
      assert.equal(await app.frame.locator("#rows tr").count(), 4);
      assert.equal((await app.calls()).length, 1, "exactly one call, made on mount");
    } finally { await app.close(); }
  });

  test(`[${engine}] a row can be selected with the pointer`, async () => {
    const app = await openApp(engine, SERVER);
    try {
      await app.frame.locator("#rows tr").first().click();
      assert.equal(await app.frame.locator('#rows tr[aria-selected="true"]').count(), 1);
    } finally { await app.close(); }
  });

  test(`[${engine}] a row can be selected from the keyboard alone`, async () => {
    const app = await openApp(engine, SERVER);
    try {
      const row = app.frame.locator("#rows tr").nth(1);
      await row.focus();
      await app.page.keyboard.press("Enter");
      const selected = app.frame.locator('#rows tr[aria-selected="true"]');
      assert.equal(await selected.count(), 1);
      assert.match(await selected.textContent(), /billing/);
    } finally { await app.close(); }
  });

  test(`[${engine}] the view says so when the server refuses`, async () => {
    const app = await openApp(engine, SERVER);
    try {
      // Remount with the server made to fail, so the error path is the one
      // a person would actually meet rather than a mocked stand-in.
      await app.page.evaluate(() => {
        window.__callServer = () => Promise.reject(new Error("the deployment index is offline"));
      });
      const html = await app.frame.locator("html").innerHTML();
      await app.page.evaluate((h) => window.__mount(`<!doctype html>${h}`), html);
      await app.frame.locator("#error").waitFor({ state: "visible", timeout: 8000 });
      assert.match(await app.frame.locator("#error").textContent(), /offline/);
    } finally { await app.close(); }
  });
}
