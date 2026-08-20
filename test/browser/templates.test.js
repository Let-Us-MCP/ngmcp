import test from "node:test";
import assert from "node:assert/strict";
import { mount, VIEW } from "./component-harness.mjs";

const ENGINES = (process.env.NGMCP_ENGINES ?? "chromium,webkit").split(",");
const I = `import { listTemplate, gridStack, h, signal } from "${VIEW}";`;

/* The four things a dashboard shell owes that a page does not: panels that
 * load apart, a refresh that costs one panel rather than the board, a layout
 * that is a value the caller can persist, and one column when the host hands
 * out 320 pixels. */

const BOARD = `${I}
  const root = document.getElementById("root");
  root.style.width = "900px";
  window.__calls = { deployments: 0, incidents: 0 };
  window.__fail = false;
  window.__layouts = [];
  const board = gridStack({
    columns: 12,
    label: "Operations",
    onLayoutChange: (layout) => window.__layouts.push(layout),
    panels: [
      { id: "deployments", title: "Deployments", x: 0, y: 0, w: 6, h: 1,
        load: () => {
          window.__calls.deployments += 1;
          return h("p", { class: "count", text: "deployments " + window.__calls.deployments });
        } },
      { id: "incidents", title: "Incidents", x: 6, y: 0, w: 6, h: 1,
        load: async () => {
          window.__calls.incidents += 1;
          if (window.__fail) throw new Error("Upstream 503.");
          return h("p", { class: "count", text: "incidents " + window.__calls.incidents });
        } },
    ],
  });
  root.appendChild(board.el);
  window.__board = board;`;

for (const engine of ENGINES) {
  const at = (n) => `[${engine}] ${n}`;

  test(at("a shell gives the reader the landmarks a page has"), async () => {
    const c = await mount(engine, `${I}
      const shell = listTemplate({
        title: "Operations",
        sidebar: h("a", { href: "#deployments", text: "Deployments" }),
        sidebarLabel: "Boards",
        actions: [h("button", { type: "button", text: "Refresh all" })],
        footer: h("small", { text: "Updated just now" }),
      }, h("p", { text: "main content" }));
      document.getElementById("root").appendChild(shell.el);`);
    try {
      assert.equal(await c.frame.locator("header h1").textContent(), "Operations");
      assert.equal(await c.frame.locator('nav[aria-label="Boards"]').count(), 1);
      assert.equal(await c.frame.locator("main").count(), 1);
      // The main region is named by the board's own title, so a reader landing
      // in it is told which board they are in.
      assert.equal(await c.frame.locator("main").evaluate((el) => {
        const target = el.ownerDocument.getElementById(el.getAttribute("aria-labelledby"));
        return target?.textContent;
      }), "Operations");
    } finally { await c.close(); }
  });

  test(at("the shell goes to one column when the frame is narrow"), async () => {
    const c = await mount(engine, `${I}
      const root = document.getElementById("root");
      const shell = listTemplate({ title: "Operations", collapseBelow: 640,
        sidebar: h("p", { text: "nav" }) }, h("p", { text: "main" }));
      root.appendChild(shell.el);
      window.__narrow = () => { root.style.width = "320px"; };
      window.__wide = () => { root.style.width = "900px"; };
      window.__shell = shell;`);
    try {
      await c.frame.locator("#root").evaluate(() => window.__wide());
      await c.page.waitForTimeout(150);
      assert.equal(await c.frame.locator(".shell-narrow").count(), 0);
      await c.frame.locator("#root").evaluate(() => window.__narrow());
      await c.frame.locator(".shell-narrow").waitFor({ timeout: 3000 });
      assert.equal(await c.frame.locator("#root").evaluate(
        () => window.__shell.narrow()), true);
    } finally { await c.close(); }
  });

  test(at("every panel loads itself, once, on mount"), async () => {
    const c = await mount(engine, BOARD);
    try {
      await c.frame.locator(".panel-ready").nth(1).waitFor();
      assert.deepEqual(
        await c.frame.locator(".count").allTextContents(),
        ["deployments 1", "incidents 1"]);
    } finally { await c.close(); }
  });

  test(at("refreshing one panel costs one panel, not the board"), async () => {
    /* A dashboard where a stale number costs a full reload is a page with a
     * spinner on it. */
    const c = await mount(engine, BOARD);
    try {
      await c.frame.locator(".panel-ready").nth(1).waitFor();
      await c.frame.locator("#root").evaluate(() => window.__board.refresh("incidents"));
      await c.frame.locator(".count").filter({ hasText: "incidents 2" }).waitFor();
      const calls = await c.frame.locator("#root").evaluate(() => window.__calls);
      assert.equal(calls.incidents, 2);
      assert.equal(calls.deployments, 1, "the whole board was re-fetched");
    } finally { await c.close(); }
  });

  test(at("the refresh button on a panel refreshes that panel"), async () => {
    const c = await mount(engine, BOARD);
    try {
      await c.frame.locator(".panel-ready").nth(1).waitFor();
      await c.frame.locator("#board-1-deployments .panel-refresh").click();
      await c.frame.locator(".count").filter({ hasText: "deployments 2" }).waitFor();
      const calls = await c.frame.locator("#root").evaluate(() => window.__calls);
      assert.equal(calls.deployments, 2);
      assert.equal(calls.incidents, 1);
    } finally { await c.close(); }
  });

  test(at("a panel that failed says so and the board carries on"), async () => {
    const c = await mount(engine, BOARD);
    try {
      await c.frame.locator(".panel-ready").nth(1).waitFor();
      await c.frame.locator("#root").evaluate(() => { window.__fail = true; });
      await c.frame.locator("#root").evaluate(() => window.__board.refresh("incidents"));
      await c.frame.locator(".panel-failed").waitFor();
      assert.match(await c.frame.locator(".panel-failed .panel-error").textContent(), /503/);
      // The panel that did not fail is untouched and still readable.
      assert.equal(await c.frame.locator("#board-1-deployments .count").textContent(),
        "deployments 1");
      assert.equal(await c.frame.locator(".panel-failed").count(), 1);
    } finally { await c.close(); }
  });

  test(at("a panel moves from the keyboard and says where it went"), async () => {
    const c = await mount(engine, BOARD);
    try {
      await c.frame.locator(".panel-ready").nth(1).waitFor();
      const panel = c.frame.locator("#board-1-deployments");
      await panel.focus();
      await c.page.keyboard.press("ArrowRight");
      assert.equal(await panel.evaluate((el) => el.style.gridColumn), "2 / span 6");
      assert.match(await c.frame.locator(".board .sr-only").textContent(),
        /Deployments, column 2, row 1, 6 wide, 1 tall/);
    } finally { await c.close(); }
  });

  test(at("shift and an arrow resizes rather than moves"), async () => {
    const c = await mount(engine, BOARD);
    try {
      await c.frame.locator(".panel-ready").nth(1).waitFor();
      const panel = c.frame.locator("#board-1-deployments");
      await panel.focus();
      await c.page.keyboard.press("Shift+ArrowRight");
      assert.equal(await panel.evaluate((el) => el.style.gridColumn), "1 / span 7");
      await c.page.keyboard.press("Shift+ArrowDown");
      assert.equal(await panel.evaluate((el) => el.style.gridRow), "1 / span 2");
    } finally { await c.close(); }
  });

  test(at("a panel cannot be pushed off the board"), async () => {
    const c = await mount(engine, BOARD);
    try {
      await c.frame.locator(".panel-ready").nth(1).waitFor();
      const panel = c.frame.locator("#board-1-deployments");
      await panel.focus();
      for (let i = 0; i < 4; i += 1) await c.page.keyboard.press("ArrowLeft");
      assert.equal(await panel.evaluate((el) => el.style.gridColumn), "1 / span 6");
      for (let i = 0; i < 4; i += 1) await c.page.keyboard.press("ArrowUp");
      assert.equal(await panel.evaluate((el) => el.style.gridRow), "1 / span 1");
    } finally { await c.close(); }
  });

  test(at("the layout is a value, so a tool can be handed it"), async () => {
    /* The protocol has no sessions. Nothing here remembers the layout for the
     * caller: it comes out as a plain value, goes to a tool as an ordinary
     * argument, and comes back as a handle. */
    const c = await mount(engine, BOARD);
    try {
      await c.frame.locator(".panel-ready").nth(1).waitFor();
      const panel = c.frame.locator("#board-1-deployments");
      await panel.focus();
      await c.page.keyboard.press("ArrowRight");
      const layout = await c.frame.locator("#root").evaluate(() => window.__board.layout());
      assert.equal(layout.columns, 12);
      assert.deepEqual(layout.panels, [
        { id: "deployments", x: 1, y: 0, w: 6, h: 1 },
        { id: "incidents", x: 6, y: 0, w: 6, h: 1 },
      ]);
      assert.equal(JSON.parse(JSON.stringify(layout)).panels.length, 2,
        "the layout does not survive being serialised, so it cannot be an argument");
      const reported = await c.frame.locator("#root").evaluate(() => window.__layouts);
      assert.equal(reported.length, 1, "moving a panel did not report the layout");
      assert.deepEqual(reported[0].panels[0], { id: "deployments", x: 1, y: 0, w: 6, h: 1 });
    } finally { await c.close(); }
  });

  test(at("a layout handed back puts the board where it was"), async () => {
    const c = await mount(engine, BOARD);
    try {
      await c.frame.locator(".panel-ready").nth(1).waitFor();
      await c.frame.locator("#root").evaluate(() => window.__board.apply({
        columns: 12,
        panels: [
          { id: "incidents", x: 0, y: 0, w: 8, h: 2 },
          { id: "deployments", x: 8, y: 0, w: 4, h: 1 },
          // A panel this board does not have: a layout from an older version
          // of the board is a normal thing to be handed.
          { id: "gone", x: 0, y: 4, w: 2, h: 1 },
        ],
      }));
      assert.equal(await c.frame.locator("#board-1-incidents").evaluate(
        (el) => el.style.gridColumn), "1 / span 8");
      assert.equal(await c.frame.locator("#board-1-deployments").evaluate(
        (el) => el.style.gridColumn), "9 / span 4");
    } finally { await c.close(); }
  });

  test(at("the board goes to one column at 320 pixels and back again"), async () => {
    const c = await mount(engine, `${BOARD}
      window.__narrow = () => { document.getElementById("root").style.width = "320px"; };
      window.__wide = () => { document.getElementById("root").style.width = "900px"; };`);
    try {
      await c.frame.locator(".panel-ready").nth(1).waitFor();
      await c.frame.locator("#root").evaluate(() => window.__narrow());
      await c.frame.locator(".board-narrow").waitFor({ timeout: 3000 });
      assert.equal(await c.frame.locator(".board").evaluate(
        (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length), 1);
      assert.equal(await c.frame.locator("#board-1-deployments").evaluate(
        (el) => el.style.gridColumn), "1 / -1");
      // Widening puts it back where it was: the placement was kept, not lost.
      await c.frame.locator("#root").evaluate(() => window.__wide());
      await c.page.waitForTimeout(200);
      assert.equal(await c.frame.locator("#board-1-deployments").evaluate(
        (el) => el.style.gridColumn), "1 / span 6");
    } finally { await c.close(); }
  });

  test(at("a panel is a region with a name and says when it is busy"), async () => {
    const c = await mount(engine, BOARD);
    try {
      await c.frame.locator(".panel-ready").nth(1).waitFor();
      const named = await c.frame.locator("#board-1-incidents").evaluate((el) => ({
        role: el.tagName.toLowerCase(),
        name: el.ownerDocument.getElementById(el.getAttribute("aria-labelledby"))?.textContent,
        busy: el.getAttribute("aria-busy"),
      }));
      assert.equal(named.role, "section");
      assert.equal(named.name, "Incidents");
      assert.equal(named.busy, "false");
    } finally { await c.close(); }
  });
}
