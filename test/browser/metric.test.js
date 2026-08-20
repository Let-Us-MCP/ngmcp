import test from "node:test";
import assert from "node:assert/strict";
import { mount, VIEW } from "./component-harness.mjs";

const ENGINES = (process.env.NGMCP_ENGINES ?? "chromium,webkit").split(",");
const I = `import { metric, signal } from "${VIEW}";`;

for (const engine of ENGINES) {
  const at = (n) => `[${engine}] ${n}`;

  test(at("shows the value, the unit and the label"), async () => {
    const c = await mount(engine, `${I}
      const m = metric({ label: "Error rate", value: 143, unit: "/h" });
      document.getElementById("root").appendChild(m.el);`);
    try {
      assert.equal(await c.frame.locator(".metric-label").textContent(), "Error rate");
      assert.equal(await c.frame.locator(".metric-number").textContent(), "143");
      assert.match(await c.frame.locator(".metric-unit").textContent(), /\/h/);
    } finally { await c.close(); }
  });

  test(at("formats large numbers rather than printing raw digits"), async () => {
    const c = await mount(engine, `${I}
      const m = metric({ label: "Requests", value: 1234567, locale: "en-US" });
      document.getElementById("root").appendChild(m.el);`);
    try {
      const shown = await c.frame.locator(".metric-number").textContent();
      assert.notEqual(shown, "1234567", "a bare digit run is unreadable at a glance");
      assert.match(shown, /1.234.567/);
    } finally { await c.close(); }
  });

  test(at("a rise in a bad thing is coloured bad, not green"), async () => {
    const c = await mount(engine, `${I}
      const m = metric({ label: "Errors", value: 143, delta: 20, deltaIsGood: "down" });
      document.getElementById("root").appendChild(m.el);`);
    try {
      assert.equal(await c.frame.locator(".metric-delta").getAttribute("class"),
        "metric-delta bad", "colouring by sign alone gets this backwards");
      assert.equal(await c.frame.locator(".metric-delta").textContent(), "+20");
    } finally { await c.close(); }
  });

  test(at("a rise in a good thing is coloured good"), async () => {
    const c = await mount(engine, `${I}
      const m = metric({ label: "Uptime", value: 99, delta: 2, deltaIsGood: "up" });
      document.getElementById("root").appendChild(m.el);`);
    try {
      assert.equal(await c.frame.locator(".metric-delta").getAttribute("class"),
        "metric-delta good");
    } finally { await c.close(); }
  });

  test(at("it updates when its signal changes, without rebuilding"), async () => {
    const c = await mount(engine, `${I}
      const v = signal(10);
      const m = metric({ label: "Queue", value: v });
      document.getElementById("root").appendChild(m.el);
      window.__bump = () => v.set(42);`);
    try {
      assert.equal(await c.frame.locator(".metric-number").textContent(), "10");
      await c.frame.locator(".metric").evaluate(() => window.__bump());
      await c.frame.locator(".metric-number").filter({ hasText: "42" }).waitFor();
    } finally { await c.close(); }
  });

  test(at("the whole tile is announced as one label, not four fragments"), async () => {
    const c = await mount(engine, `${I}
      const m = metric({ label: "Checkout p95", value: 412, unit: "ms",
                         delta: -18, deltaIsGood: "down", note: "since 4.18.2" });
      document.getElementById("root").appendChild(m.el);`);
    try {
      const label = await c.frame.locator(".metric").getAttribute("aria-label");
      assert.match(label, /Checkout p95, 412 ms/);
      assert.match(label, /change -18/);
      assert.match(label, /since 4\.18\.2/);
    } finally { await c.close(); }
  });

  test(at("it is a button only when there is something to do"), async () => {
    const inert = await mount(engine, `${I}
      document.getElementById("root").appendChild(metric({ label: "A", value: 1 }).el);`);
    try {
      assert.equal(await inert.frame.locator("button.metric").count(), 0,
        "a tile that looks clickable and is not is worse than one that looks inert");
    } finally { await inert.close(); }

    const live = await mount(engine, `${I}
      const m = metric({ label: "A", value: 1, onActivate: () => { window.__hit = true; } });
      document.getElementById("root").appendChild(m.el);`);
    try {
      assert.equal(await live.frame.locator("button.metric").count(), 1);
      await live.frame.locator("button.metric").focus();
      await live.page.keyboard.press("Enter");
      assert.equal(await live.frame.locator("button.metric").evaluate(() => window.__hit), true);
    } finally { await live.close(); }
  });
}
