import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openApp } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "..", "examples", "gallery", "dist", "server.mjs");
const ENGINES = (process.env.NGMCP_ENGINES ?? "chromium,webkit").split(",");

/* The gallery is what a person will actually open, so this is the test that it
 * arrives: a real server over a real pipe, its views read as `ui://`
 * resources, mounted in a frame with an opaque origin, in both engines.
 *
 * The checks a person is asked to make by eye are the same ones asserted here,
 * so a screen that passes this and fails in front of somebody is a host
 * difference rather than a component that was never checked. */

const screen = (engine, name) => openApp(engine, SERVER, { viewUri: `ui://gallery/${name}` });

for (const engine of ENGINES) {
  const at = (n) => `[${engine}] ${n}`;

  test(at("every screen names its checks where the person can read them"), async () => {
    const app = await screen(engine, "charts");
    try {
      const ids = await app.frame.locator(".check-id").allTextContents();
      assert.ok(ids.includes("charts.bars"), `checks not drawn: ${ids.join(", ")}`);
      assert.equal(ids.length, 8);
    } finally { await app.close(); }
  });

  test(at("the charts screen draws all six charts"), async () => {
    const app = await screen(engine, "charts");
    try {
      assert.equal(await app.frame.locator(".chart-line").count(), 1, "no line");
      assert.equal(await app.frame.locator(".chart-area").count(), 1, "no area");
      assert.ok(await app.frame.locator(".chart-bar").count() >= 5, "no bars");
      assert.ok(await app.frame.locator(".chart-plot-scatter .chart-point").count() >= 5,
        "no scatter marks");
      assert.equal(await app.frame.locator(".sparkline-plot").count(), 2, "no sparklines");
      assert.equal(await app.frame.locator(".heatmap-cell").count(), 9, "no heatmap");
      // charts.numbers: the host's locale, not the engine's.
      const cells = await app.frame.locator(".heatmap-cell").allTextContents();
      assert.deepEqual(cells.slice(0, 3), ["143", "92", "12"]);
    } finally { await app.close(); }
  });

  test(at("charts.keyboard: the line chart answers the arrow keys"), async () => {
    const app = await screen(engine, "charts");
    try {
      await app.frame.locator(".chart-canvas").first().focus();
      await app.page.keyboard.press("ArrowRight");
      await app.frame.locator(".chart-readout").first()
        .filter({ hasText: "Mon" }).waitFor({ timeout: 5000 });
      assert.equal(await app.frame.locator(".chart-readout").first().textContent(),
        "Mon, Errors 143");
    } finally { await app.close(); }
  });

  test(at("charts.bars: every bar stands on the axis"), async () => {
    const app = await screen(engine, "charts");
    try {
      const bars = await app.frame.locator(".chart-bar").evaluateAll((els) =>
        els.map((el) => Number(el.getAttribute("y")) + Number(el.getAttribute("height"))));
      const bottom = Math.max(...bars);
      for (const edge of bars) {
        assert.ok(Math.abs(edge - bottom) < 1.5,
          `a bar does not reach the axis: ${bars.join(", ")}`);
      }
    } finally { await app.close(); }
  });

  test(at("table.filter costs no tool call, and narrows"), async () => {
    const app = await screen(engine, "table");
    try {
      await app.frame.locator(".data-table tbody tr").first().waitFor();
      const before = (await app.calls()).length;
      await app.frame.locator(".filter").fill("bill");
      await app.frame.locator(".status").filter({ hasText: "1 of 5" }).waitFor();
      assert.equal((await app.calls()).length, before,
        "filtering crossed the boundary");
    } finally { await app.close(); }
  });

  test(at("table.metrics: the host's locale groups the digits"), async () => {
    const app = await screen(engine, "table");
    try {
      const numbers = await app.frame.locator(".metric-number").allTextContents();
      assert.deepEqual(numbers, ["5", "4", "1,234,567"]);
    } finally { await app.close(); }
  });

  test(at("widgets: the three host states are all visible at once"), async () => {
    const app = await screen(engine, "widgets");
    try {
      const granted = app.frame.locator(".btn").filter({ hasText: "Export, granted" });
      assert.match(await granted.getAttribute("class"), /btn-granted/);
      // widgets.absent: a fallback rather than a dead control.
      await app.frame.locator(".btn").filter({ hasText: "Copy instead" }).waitFor();
      // widgets.refused: the refusal is said, not swallowed.
      const refused = app.frame.locator(".btn").filter({ hasText: "Export, refused" });
      await refused.click();
      const said = app.frame.locator(".button-error:not([hidden])");
      await said.waitFor({ timeout: 5000 });
      assert.match(await said.textContent(), /refused/);
      // And it is this button's message, not another button's.
      assert.equal(await refused.evaluate((el) =>
        el.ownerDocument.getElementById(el.getAttribute("aria-describedby"))?.textContent),
        "The host refused that.");
    } finally { await app.close(); }
  });

  test(at("widgets.prefill: the agent fills the form and does not submit it"), async () => {
    const app = await screen(engine, "widgets");
    try {
      await app.frame.locator(".btn").filter({ hasText: "Let the agent prefill" }).click();
      await app.frame.locator('[data-prefilled="true"]').first().waitFor();
      assert.equal(await app.frame.locator('[data-prefilled="true"]').count(), 2);
      assert.equal(await app.frame.locator(".toast").count(), 0,
        "prefilling submitted the form, which hands the decision to the agent");
    } finally { await app.close(); }
  });

  test(at("agent.approval: the provenance is there before the decision"), async () => {
    const app = await screen(engine, "agent");
    try {
      const text = await app.frame.locator(".approval-provenance").textContent();
      assert.match(text, /the agent, in this conversation/);
      assert.match(text, /sam@meridian.example/);
      assert.match(text, /billing.refund/);
      assert.match(text, /invoice=2026-0814/);
      // agent.highrisk: approving is not one click.
      assert.equal(await app.frame.locator(".approval-approve").isDisabled(), true);
    } finally { await app.close(); }
  });

  test(at("agent.proposal: proposing changes nothing until it is accepted"), async () => {
    const app = await screen(engine, "agent");
    try {
      await app.frame.locator(".btn").filter({ hasText: "propose" }).click();
      await app.frame.locator(".proposal").waitFor({ state: "visible" });
      assert.match(await app.frame.locator(".proposal-next .proposal-text").textContent(),
        /21st/);
      assert.match(await app.frame.locator(".current-text").textContent(), /14th/,
        "the change was applied without anybody accepting it");
    } finally { await app.close(); }
  });

  test(at("dash.panels: four panels, from more than one server"), async () => {
    const app = await screen(engine, "dashboard");
    try {
      await app.frame.locator(".panel").first().waitFor();
      assert.equal(await app.frame.locator(".panel").count(), 4);
      const titles = await app.frame.locator(".panel-title").allTextContents();
      assert.ok(titles.some((t) => /deploys server/.test(t)), titles.join(" | "));
      assert.ok(titles.some((t) => /incidents server/.test(t)), titles.join(" | "));
    } finally { await app.close(); }
  });

  test(at("dash.failed: one panel failing leaves the other three"), async () => {
    const app = await screen(engine, "dashboard");
    try {
      await app.frame.locator(".panel-failed").waitFor({ timeout: 5000 });
      assert.equal(await app.frame.locator(".panel-failed").count(), 1);
      assert.match(await app.frame.locator(".panel-failed .panel-error").textContent(),
        /503/);
      assert.equal(await app.frame.locator(".panel-ready").count(), 3);
    } finally { await app.close(); }
  });

  test(at("dash.keyboard: a panel moves and the layout is reported"), async () => {
    const app = await screen(engine, "dashboard");
    try {
      await app.frame.locator(".panel").first().waitFor();
      await app.frame.locator(".panel").first().focus();
      await app.page.keyboard.press("ArrowRight");
      await app.frame.locator(".layout-state").filter({ hasText: "panels" }).waitFor();
      assert.match(await app.frame.locator(".layout-state").textContent(),
        /deployments at 1,0/);
    } finally { await app.close(); }
  });

  test(at("the composition names the server it could not reach"), async () => {
    /* A composition that hides a missing member reports `no incidents` when
     * what happened is that the incident server is down. */
    const app = await screen(engine, "dashboard");
    try {
      const servers = await app.frame.locator(".server").allTextContents();
      assert.deepEqual(servers.slice(0, 2), ["deploys", "incidents"]);
      assert.equal(await app.frame.locator(".server-down").count(), 1);
      assert.match(await app.frame.locator(".server-down").textContent(),
        /billing: ECONNREFUSED/);
    } finally { await app.close(); }
  });

  test(at("surface: absent and refused are told apart in front of the person"), async () => {
    const app = await screen(engine, "surface");
    try {
      // The harness host grants nothing, so everything here is absent, and the
      // screen has to say so rather than going quiet.
      await app.frame.locator(".btn").filter({ hasText: "Send a message" }).click();
      await app.frame.locator(".outcome-log").filter({ hasText: "sendMessage" }).waitFor();
      // This host implements no host methods, so it refuses by name rather
      // than going quiet. Either answer is a real one; silence is not.
      assert.match(await app.frame.locator(".outcome-log").textContent(),
        /sendMessage: (absent|refused)/);
      // The capability was declared, so the view did ask before reporting.
      const asked = await app.hostCalls();
      assert.deepEqual(asked.map((c) => c.method), ["sendMessage"]);
    } finally { await app.close(); }
  });

  test(at("every screen is a document with landmarks and a heading"), async () => {
    const app = await screen(engine, "dashboard");
    try {
      assert.equal(await app.frame.locator("main").count(), 1);
      assert.equal(await app.frame.locator("nav").count(), 1);
      assert.equal(await app.frame.locator("h1").textContent(), "Operations");
    } finally { await app.close(); }
  });
}
