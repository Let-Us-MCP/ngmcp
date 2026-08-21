import test from "node:test";
import assert from "node:assert/strict";
import { mount, VIEW } from "./component-harness.mjs";

const ENGINES = (process.env.NGMCP_ENGINES ?? "chromium,webkit").split(",");

const ROWS = `[
  { day: "Mon", errors: 143, latency: 210 },
  { day: "Tue", errors: 92,  latency: 180 },
  { day: "Wed", errors: 12,  latency: 240 },
  { day: "Thu", errors: 61,  latency: 150 },
  { day: "Fri", errors: 7,   latency: 120 }
]`;

const I = `import { lineChart, areaChart, barChart, scatterChart, sparkline, heatmap, signal } from "${VIEW}";`;

const LINE = `${I}
  const rows = signal(${ROWS});
  const c = lineChart({
    rows, x: "day", xLabel: "Day", title: "Errors this week",
    series: [{ key: "errors", label: "Errors" }],
    locale: "en-US",
  });
  document.getElementById("root").appendChild(c.el);
  window.__c = c; window.__rows = rows;`;

for (const engine of ENGINES) {
  const at = (n) => `[${engine}] ${n}`;

  test(at("a line chart draws a mark for every row"), async () => {
    const c = await mount(engine, LINE);
    try {
      assert.equal(await c.frame.locator(".chart-line").count(), 1);
      assert.equal(await c.frame.locator(".chart-point").count(), 5);
      assert.equal(await c.frame.locator(".chart-title").textContent(), "Errors this week");
    } finally { await c.close(); }
  });

  test(at("the numbers are readable, not only the picture"), async () => {
    /* A chart that offers a summary and no numbers has flattened its data back
     * into a sentence, which is the thing an app exists to stop doing. */
    const c = await mount(engine, LINE);
    try {
      const cells = await c.frame.locator(".chart-data tbody td").allTextContents();
      assert.deepEqual(cells, ["143", "92", "12", "61", "7"]);
      const heads = await c.frame.locator(".chart-data tbody th").allTextContents();
      assert.deepEqual(heads, ["Mon", "Tue", "Wed", "Thu", "Fri"]);
      assert.equal(await c.frame.locator(".chart-data thead th").first().textContent(), "Day");
      // Present is not the same as reachable. The table is off screen on
      // purpose; hidden from assistive technology it would be decoration that
      // still answers a query for its own text.
      const exposure = await c.frame.locator(".chart-data").evaluate((el) => ({
        removed: el.hidden || el.getAttribute("aria-hidden") === "true",
        display: getComputedStyle(el).display,
      }));
      assert.equal(exposure.removed, false, "the numbers are hidden from assistive technology");
      assert.notEqual(exposure.display, "none", "the numbers are not rendered at all");
    } finally { await c.close(); }
  });

  test(at("arrow keys step through the points and say where they are"), async () => {
    const c = await mount(engine, LINE);
    try {
      await c.frame.locator(".chart-canvas").focus();
      await c.page.keyboard.press("ArrowRight");
      await c.frame.locator(".chart-readout").filter({ hasText: "Mon" }).waitFor();
      assert.equal(await c.frame.locator(".chart-readout").textContent(),
        "Mon, Errors 143");
      await c.page.keyboard.press("ArrowRight");
      assert.equal(await c.frame.locator(".chart-readout").textContent(),
        "Tue, Errors 92");
      await c.page.keyboard.press("ArrowLeft");
      assert.equal(await c.frame.locator(".chart-readout").textContent(),
        "Mon, Errors 143");
    } finally { await c.close(); }
  });

  test(at("Home and End reach the ends without walking there"), async () => {
    const c = await mount(engine, LINE);
    try {
      await c.frame.locator(".chart-canvas").focus();
      await c.page.keyboard.press("End");
      assert.match(await c.frame.locator(".chart-readout").textContent(), /^Fri, /);
      await c.page.keyboard.press("Home");
      assert.match(await c.frame.locator(".chart-readout").textContent(), /^Mon, /);
    } finally { await c.close(); }
  });

  test(at("the readout says nothing until the reader moves"), async () => {
    const c = await mount(engine, LINE);
    try {
      assert.equal(await c.frame.locator(".chart-readout").isVisible(), false);
      assert.equal(await c.frame.locator(".chart-cursor").getAttribute("visibility"), "hidden");
    } finally { await c.close(); }
  });

  test(at("the plot is one tab stop, not one per point"), async () => {
    const c = await mount(engine, LINE);
    try {
      const stops = await c.frame.locator(".chart [tabindex]").evaluateAll(
        (els) => els.map((el) => el.getAttribute("tabindex")));
      assert.deepEqual(stops, ["0"]);
    } finally { await c.close(); }
  });

  test(at("a panel that answered again redraws without being rebuilt"), async () => {
    /* A dashboard refreshes one panel at a time. A chart built from a snapshot
     * of its rows shows the answer to a question nobody asked any more. */
    const c = await mount(engine, LINE);
    try {
      assert.equal(await c.frame.locator(".chart-point").count(), 5);
      await c.frame.locator("#root").evaluate(() => window.__rows.set([
        { day: "Sat", errors: 3, latency: 90 },
        { day: "Sun", errors: 4, latency: 95 },
      ]));
      await c.frame.locator(".chart-point").nth(1).waitFor();
      assert.equal(await c.frame.locator(".chart-point").count(), 2);
      assert.deepEqual(
        await c.frame.locator(".chart-data tbody td").allTextContents(), ["3", "4"]);
    } finally { await c.close(); }
  });

  test(at("the number format comes from the host, not from the engine"), async () => {
    /* Asserted with a locale that groups differently from any plausible
     * default. `en-US` was the obvious choice and was the wrong one: on a
     * machine whose engines already default to that grouping, dropping the
     * host locale entirely changes nothing and the test passes over the
     * defect. It caught the bug locally and not on CI, which is the same as
     * not catching it. */
    const c = await mount(engine, `${I}
      const c = lineChart({
        rows: [{ day: "Mon", big: 1234567 }, { day: "Tue", big: 1000000 }],
        x: "day", title: "Requests", locale: "de-DE",
        series: [{ key: "big", label: "Requests" }] });
      document.getElementById("root").appendChild(c.el);`);
    try {
      assert.equal(
        await c.frame.locator(".chart-data tbody td").first().textContent(), "1.234.567",
        "the host's locale was ignored in favour of the engine's own");
    } finally { await c.close(); }
  });

  test(at("bars stand on zero, so a fall goes down from it"), async () => {
    /* Drawing every bar from the top of the frame is the usual mistake, and it
     * puts a negative value above the axis pointing the wrong way. */
    const c = await mount(engine, `${I}
      const c = barChart({
        rows: [{ region: "North", change: 40 }, { region: "South", change: -25 }],
        x: "region", title: "Change by region",
        series: [{ key: "change", label: "Change" }], locale: "en-US" });
      document.getElementById("root").appendChild(c.el);`);
    try {
      const bars = await c.frame.locator(".chart-bar").evaluateAll((els) =>
        els.map((el) => ({
          y: Number(el.getAttribute("y")),
          height: Number(el.getAttribute("height")),
        })));
      assert.equal(bars.length, 2);
      const [up, down] = bars;
      // The rise ends where the fall starts: the zero line they share.
      assert.ok(Math.abs((up.y + up.height) - down.y) < 1.5,
        `bars do not meet at zero: ${JSON.stringify(bars)}`);
      assert.ok(up.height > 1 && down.height > 1, "a bar has no length");
    } finally { await c.close(); }
  });

  test(at("an area chart closes its shape on the axis"), async () => {
    const c = await mount(engine, `${I}
      const c = areaChart({ rows: ${ROWS}, x: "day", title: "Latency",
        series: [{ key: "latency", label: "Latency" }], locale: "en-US" });
      document.getElementById("root").appendChild(c.el);`);
    try {
      const d = await c.frame.locator(".chart-area").getAttribute("d");
      assert.match(d, /^M/, "the shape does not start with a move");
      assert.match(d, /Z$/, "an unclosed area is a line with a fill bug");
    } finally { await c.close(); }
  });

  test(at("a scatter chart positions by two fields, not by row order"), async () => {
    const c = await mount(engine, `${I}
      const c = scatterChart({
        rows: [{ n: 1, latency: 240, errors: 9 }, { n: 2, latency: 120, errors: 3 }],
        x: "latency", xValue: "latency", title: "Errors against latency",
        series: [{ key: "errors", label: "Errors" }], locale: "en-US" });
      document.getElementById("root").appendChild(c.el);`);
    try {
      const xs = await c.frame.locator(".chart-point").evaluateAll(
        (els) => els.map((el) => Number(el.getAttribute("cx"))));
      assert.equal(xs.length, 2);
      // The slower point comes first in the rows and belongs on the right, so
      // plotting by row order puts it on the left and this fails.
      assert.ok(xs[0] > xs[1], "the marks are placed by row order, not by value");
    } finally { await c.close(); }
  });

  test(at("a sparkline says its range and which way it went"), async () => {
    const c = await mount(engine, `${I}
      const s = sparkline({ rows: ${ROWS}, key: "errors", label: "Errors",
        x: "day", locale: "en-US" });
      document.getElementById("root").appendChild(s.el);`);
    try {
      const label = await c.frame.locator(".sparkline-plot").getAttribute("aria-label");
      assert.match(label, /Errors/);
      assert.match(label, /from 7 to 143/);
      assert.match(label, /falling/);
      assert.equal(await c.frame.locator(".sparkline path").count(), 1);
    } finally { await c.close(); }
  });

  test(at("a heatmap cell carries its number, not only its colour"), async () => {
    /* Colour is not a channel every reader has. A cell that encodes value only
     * as lightness is unreadable to some proportion of them. */
    const c = await mount(engine, `${I}
      const c = heatmap({
        rows: [{ service: "checkout", mon: 143, tue: 92 },
               { service: "billing", mon: 12, tue: 61 }],
        row: "service", title: "Errors by service",
        columns: [{ key: "mon", label: "Mon" }, { key: "tue", label: "Tue" }],
        locale: "en-US" });
      document.getElementById("root").appendChild(c.el);`);
    try {
      assert.deepEqual(
        await c.frame.locator(".heatmap-cell").allTextContents(),
        ["143", "92", "12", "61"]);
      const opacity = await c.frame.locator(".heatmap-cell").evaluateAll(
        (els) => els.map((el) => Number(el.style.opacity)));
      assert.ok(opacity[0] > opacity[2], "the largest value is not the strongest");
    } finally { await c.close(); }
  });

  test(at("an empty chart says so rather than drawing nothing"), async () => {
    const c = await mount(engine, `${I}
      const c = lineChart({ rows: [], x: "day", title: "Errors",
        series: [{ key: "errors", label: "Errors" }], locale: "en-US" });
      document.getElementById("root").appendChild(c.el);
      window.__c = c;`);
    try {
      assert.equal(await c.frame.locator(".chart-point").count(), 0);
      assert.match(
        await c.frame.locator("#root").evaluate(() => window.__c.description()),
        /no data/);
    } finally { await c.close(); }
  });
}
