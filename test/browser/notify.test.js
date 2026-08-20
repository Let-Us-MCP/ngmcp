import test from "node:test";
import assert from "node:assert/strict";
import { mount, VIEW } from "./component-harness.mjs";

const ENGINES = (process.env.NGMCP_ENGINES ?? "chromium,webkit").split(",");
const I = `import { toaster, banner } from "${VIEW}";`;

for (const engine of ENGINES) {
  const at = (n) => `[${engine}] ${n}`;

  test(at("a toast appears and can be dismissed"), async () => {
    const c = await mount(engine, `${I}
      const t = toaster({ timeoutMs: 0 });
      document.getElementById("root").appendChild(t.el);
      t.show("Export finished", "success");`);
    try {
      assert.equal(await c.frame.locator(".toast").count(), 1);
      assert.equal(await c.frame.locator(".toast-text").textContent(), "Export finished");
      await c.frame.locator(".toast-close").click();
      assert.equal(await c.frame.locator(".toast").count(), 0);
    } finally { await c.close(); }
  });

  test(at("a burst becomes one announcement, not twenty interruptions"), async () => {
    const c = await mount(engine, `${I}
      const t = toaster({ timeoutMs: 0, coalesceMs: 120, max: 50 });
      document.getElementById("root").appendChild(t.el);
      for (let i = 1; i <= 20; i += 1) t.show("line " + i);`);
    try {
      // Everything is visible; only the announcement is coalesced.
      assert.equal(await c.frame.locator(".toast").count(), 20);
      await c.page.waitForTimeout(300);
      const spoken = await c.frame.locator("[role=status]").textContent();
      assert.match(spoken, /20 notifications/,
        "each toast was announced separately, which is unusable at speed");
      assert.match(spoken, /line 20/);
    } finally { await c.close(); }
  });

  test(at("a single message is announced as itself, not as a count"), async () => {
    const c = await mount(engine, `${I}
      const t = toaster({ timeoutMs: 0, coalesceMs: 80 });
      document.getElementById("root").appendChild(t.el);
      t.show("Saved");`);
    try {
      await c.page.waitForTimeout(220);
      assert.equal(await c.frame.locator("[role=status]").textContent(), "Saved");
    } finally { await c.close(); }
  });

  test(at("the visible toast is not itself a live region"), async () => {
    const c = await mount(engine, `${I}
      const t = toaster({ timeoutMs: 0 });
      document.getElementById("root").appendChild(t.el);
      t.show("hello");`);
    try {
      assert.equal(await c.frame.locator(".toast").getAttribute("aria-live"), null,
        "two live regions means everything is said twice");
      assert.equal(await c.frame.locator(".toasts [role=status]").count(), 0);
    } finally { await c.close(); }
  });

  test(at("old toasts are dropped past the maximum"), async () => {
    const c = await mount(engine, `${I}
      const t = toaster({ timeoutMs: 0, max: 3 });
      document.getElementById("root").appendChild(t.el);
      for (let i = 1; i <= 6; i += 1) t.show("m" + i);`);
    try {
      assert.equal(await c.frame.locator(".toast").count(), 3);
      assert.match(await c.frame.locator(".toast").last().textContent(), /m6/);
    } finally { await c.close(); }
  });

  test(at("a banner stays until hidden, unlike a toast"), async () => {
    const c = await mount(engine, `${I}
      const b = banner({ message: "The workspace volume is offline.", severity: "error" });
      document.getElementById("root").appendChild(b.el);
      window.__b = b;`);
    try {
      assert.equal(await c.frame.locator(".banner").isVisible(), false);
      await c.frame.locator(".banner").evaluate(() => window.__b.show());
      await c.frame.locator(".banner").waitFor({ state: "visible" });
      await c.page.waitForTimeout(400);
      assert.equal(await c.frame.locator(".banner").isVisible(), true,
        "a condition must not vanish on a timer while still being the case");
      await c.frame.locator(".banner").evaluate(() => window.__b.hide());
      assert.equal(await c.frame.locator(".banner").isVisible(), false);
    } finally { await c.close(); }
  });

  test(at("a banner can carry an action and change severity"), async () => {
    const c = await mount(engine, `${I}
      const b = banner({ message: "Disconnected", severity: "warning",
        action: { label: "Retry", onActivate: () => { window.__retried = true; } } });
      document.getElementById("root").appendChild(b.el);
      window.__b = b;
      b.show();`);
    try {
      assert.equal(await c.frame.locator(".banner").getAttribute("class"), "banner banner-warning");
      await c.frame.locator(".banner-action").click();
      assert.equal(await c.frame.locator(".banner").evaluate(() => window.__retried), true);
      await c.frame.locator(".banner").evaluate(() => window.__b.show("Gone for good", "error"));
      await c.frame.locator(".banner.banner-error").waitFor();
      assert.equal(await c.frame.locator(".banner-text").textContent(), "Gone for good");
    } finally { await c.close(); }
  });
}
