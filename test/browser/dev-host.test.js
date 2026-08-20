import test from "node:test";
import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { App, devHost } from "../../dist/index.js";

const ENGINES = { chromium, webkit };
const NAMES = (process.env.NGMCP_ENGINES ?? "chromium,webkit").split(",");

const VIEW = `<!doctype html><meta charset="utf-8">
<div id="out">loading</div>
<script type="module">
  const call = (name, args = {}) => new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2);
    const on = (e) => {
      if (e.data?.__id !== id) return;
      removeEventListener("message", on);
      e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.result);
    };
    addEventListener("message", on);
    parent.postMessage({ __call: name, __id: id, args }, "*");
  });
  window.__ask = async () => {
    try {
      const r = await call("rows");
      document.getElementById("out").textContent = r.structuredContent.rows.length + " rows";
    } catch (e) {
      document.getElementById("out").textContent = "refused: " + e.message;
    }
  };
  await window.__ask();
  document.documentElement.dataset.ready = "1";
<\/script>`;

const build = () => {
  const app = new App({ name: "dev-demo", version: "1.0.0" });
  app.view("ui://dev/table", { html: VIEW });
  app.tool("rows", { description: "Rows.", annotations: { readOnlyHint: true } },
    async () => ({ rows: [{ id: "a" }, { id: "b" }, { id: "c" }] }));
  return app;
};

for (const name of NAMES) {
  test(`[${name}] the dev host renders the view and answers its calls`, async () => {
    const host = await devHost(build(), { port: 0 });
    const browser = await ENGINES[name].launch();
    try {
      const page = await browser.newPage();
      await page.goto(host.url);
      const frame = page.frameLocator("#view");
      await frame.locator("html[data-ready='1']").waitFor({ timeout: 15000 });
      assert.equal(await frame.locator("#out").textContent(), "3 rows");
    } finally { await browser.close(); await host.close(); }
  });

  test(`[${name}] it can refuse a call, which is the thing worth having`, async () => {
    const host = await devHost(build(), { port: 0 });
    const browser = await ENGINES[name].launch();
    try {
      const page = await browser.newPage();
      await page.goto(host.url);
      const frame = page.frameLocator("#view");
      await frame.locator("html[data-ready='1']").waitFor({ timeout: 15000 });
      // A real host refuses. Finding out here beats finding out in production.
      await page.locator("#deny").check();
      await frame.locator("#out").evaluate(() => window.__ask());
      await frame.locator("#out").filter({ hasText: "refused" }).waitFor({ timeout: 8000 });
      assert.match(await frame.locator("#out").textContent(), /refused/);
    } finally { await browser.close(); await host.close(); }
  });

  test(`[${name}] it logs the traffic in both directions`, async () => {
    const host = await devHost(build(), { port: 0 });
    const browser = await ENGINES[name].launch();
    try {
      const page = await browser.newPage();
      await page.goto(host.url);
      await page.frameLocator("#view").locator("html[data-ready='1']").waitFor({ timeout: 15000 });
      const log = await page.locator("#log").textContent();
      assert.match(log, /rows/);
      assert.match(log, /structuredContent/);
    } finally { await browser.close(); await host.close(); }
  });
}
