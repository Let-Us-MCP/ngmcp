import test from "node:test";
import assert from "node:assert/strict";
import { mount, VIEW } from "./component-harness.mjs";

const ENGINES = (process.env.NGMCP_ENGINES ?? "chromium,webkit").split(",");
const I = `import { stack, row, spacer, divider, columns, card, tabs, dialog, h } from "${VIEW}";`;

for (const engine of ENGINES) {
  const at = (n) => `[${engine}] ${n}`;

  test(at("a stack flows down and a row flows across"), async () => {
    const c = await mount(engine, `${I}
      const root = document.getElementById("root");
      root.appendChild(stack({}, h("p", { text: "a" }), h("p", { text: "b" })));
      root.appendChild(row({}, h("span", { text: "x" }), spacer(), h("span", { text: "y" })));`);
    try {
      assert.equal(await c.frame.locator(".stack").evaluate(
        (el) => getComputedStyle(el).flexDirection), "column");
      assert.equal(await c.frame.locator(".row").evaluate(
        (el) => getComputedStyle(el).flexDirection), "row");
      assert.equal(await c.frame.locator(".spacer").count(), 1);
    } finally { await c.close(); }
  });

  test(at("columns collapse when the host gives them no room"), async () => {
    const c = await mount(engine, `${I}
      const root = document.getElementById("root");
      const cols = columns({ collapseBelow: 480 },
        h("div", { text: "left" }), h("div", { text: "right" }));
      root.appendChild(cols);
      window.__narrow = () => { root.style.width = "300px"; };
      window.__wide = () => { root.style.width = "900px"; };`);
    try {
      await c.frame.locator(".columns").evaluate(() => window.__wide());
      await c.page.waitForTimeout(150);
      assert.equal(await c.frame.locator(".columns.collapsed").count(), 0);
      await c.frame.locator(".columns").evaluate(() => window.__narrow());
      await c.frame.locator(".columns.collapsed").waitFor({ timeout: 3000 });
      assert.equal(await c.frame.locator(".columns").evaluate(
        (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length), 1,
        "a host handing out 300 pixels still got two columns");
    } finally { await c.close(); }
  });

  test(at("a card names itself, so a dashboard of cards is navigable"), async () => {
    const c = await mount(engine, `${I}
      document.getElementById("root").appendChild(
        card({ title: "Deployments" }, h("p", { text: "body" })));`);
    try {
      assert.equal(await c.frame.locator("section.card").getAttribute("aria-label"), "Deployments");
      assert.equal(await c.frame.locator(".card-title").textContent(), "Deployments");
      assert.equal(await c.frame.locator("h2.card-title").count(), 1);
    } finally { await c.close(); }
  });

  const TABS = `${I}
    window.__built = [];
    const t = tabs({ tabs: [
      { id: "one", label: "One", content: () => { window.__built.push("one"); return h("p", { id: "c-one", text: "first" }); } },
      { id: "two", label: "Two", content: () => { window.__built.push("two"); return h("p", { id: "c-two", text: "second" }); } },
      { id: "three", label: "Three", content: () => { window.__built.push("three"); return h("p", { id: "c-three", text: "third" }); } },
    ], label: "Sections" });
    document.getElementById("root").appendChild(t.el);
    window.__t = t;`;

  test(at("tabs follow the ARIA roles and expose the selected one"), async () => {
    const c = await mount(engine, TABS);
    try {
      assert.equal(await c.frame.locator('[role="tablist"]').getAttribute("aria-label"), "Sections");
      assert.equal(await c.frame.locator('[role="tab"]').count(), 3);
      assert.equal(await c.frame.locator('[role="tab"][aria-selected="true"]').count(), 1);
      assert.equal(await c.frame.locator('[role="tabpanel"]:not([hidden])').count(), 1);
      assert.equal(await c.frame.locator('[role="tab"]').first().getAttribute("aria-controls"), "panel-one");
    } finally { await c.close(); }
  });

  test(at("only the selected tab is in the tab order"), async () => {
    const c = await mount(engine, TABS);
    try {
      const indexes = await c.frame.locator('[role="tab"]').evaluateAll(
        (els) => els.map((e) => e.getAttribute("tabindex")));
      assert.deepEqual(indexes, ["0", "-1", "-1"],
        "Tab walks through every tab instead of moving past the list");
    } finally { await c.close(); }
  });

  test(at("arrow keys move between tabs, and wrap"), async () => {
    const c = await mount(engine, TABS);
    try {
      await c.frame.locator('[role="tab"]').first().focus();
      await c.page.keyboard.press("ArrowRight");
      assert.equal(await c.frame.locator('[role="tab"][aria-selected="true"]').textContent(), "Two");
      await c.page.keyboard.press("ArrowLeft");
      assert.equal(await c.frame.locator('[role="tab"][aria-selected="true"]').textContent(), "One");
      await c.page.keyboard.press("ArrowLeft");
      assert.equal(await c.frame.locator('[role="tab"][aria-selected="true"]').textContent(), "Three",
        "the list must wrap rather than stop");
    } finally { await c.close(); }
  });

  test(at("Home and End jump to the ends"), async () => {
    const c = await mount(engine, TABS);
    try {
      await c.frame.locator('[role="tab"]').first().focus();
      await c.page.keyboard.press("End");
      assert.equal(await c.frame.locator('[role="tab"][aria-selected="true"]').textContent(), "Three");
      await c.page.keyboard.press("Home");
      assert.equal(await c.frame.locator('[role="tab"][aria-selected="true"]').textContent(), "One");
    } finally { await c.close(); }
  });

  test(at("a hidden panel is never built, so six tabs do not fetch six times"), async () => {
    const c = await mount(engine, TABS);
    try {
      assert.deepEqual(await c.frame.locator(".tabs").evaluate(() => window.__built), ["one"]);
      await c.frame.locator('[role="tab"]').nth(1).click();
      assert.deepEqual(await c.frame.locator(".tabs").evaluate(() => window.__built), ["one", "two"]);
      await c.frame.locator('[role="tab"]').first().click();
      assert.deepEqual(await c.frame.locator(".tabs").evaluate(() => window.__built), ["one", "two"],
        "the panel was rebuilt on every visit");
    } finally { await c.close(); }
  });

  const DIALOG = `${I}
    const opener = h("button", { id: "opener", text: "Open" });
    const d = dialog({ title: "Delete four files?",
      content: h("p", { text: "This can be undone." }),
      actions: [h("button", { id: "confirm", text: "Delete" })],
      onClose: (r) => { window.__closedWith = r; } });
    opener.onclick = () => d.open();
    document.getElementById("root").appendChild(opener);
    window.__d = d;`;

  test(at("a dialog opens modally and is labelled by its title"), async () => {
    const c = await mount(engine, DIALOG);
    try {
      await c.frame.locator("#opener").click();
      await c.frame.locator("dialog[open]").waitFor();
      assert.equal(await c.frame.locator("dialog").evaluate((d) => d.open), true);
      assert.equal(await c.frame.locator("#dialog-title").textContent(), "Delete four files?");
      assert.equal(await c.frame.locator("dialog").getAttribute("aria-labelledby"), "dialog-title");
    } finally { await c.close(); }
  });

  test(at("Escape closes it and says why"), async () => {
    const c = await mount(engine, DIALOG);
    try {
      await c.frame.locator("#opener").click();
      await c.frame.locator("dialog[open]").waitFor();
      await c.page.keyboard.press("Escape");
      await c.page.waitForTimeout(250);
      assert.equal(await c.frame.locator("dialog").evaluate((d) => d.open), false);
      assert.equal(await c.frame.locator("#opener").evaluate(() => window.__closedWith), "escape");
    } finally { await c.close(); }
  });

  /* No mutant: this guards a platform guarantee rather than code of ours.
   * `<dialog>.close()` returns focus to the previously focused element in both
   * engines, which is why the hand-written restore that used to be here was
   * removed. The test stays, because if that ever stops being true the
   * component has to put it back. */
  test(at("focus returns to whatever opened it"), async () => {
    const c = await mount(engine, DIALOG);
    try {
      await c.frame.locator("#opener").focus();
      await c.page.keyboard.press("Enter");
      await c.frame.locator("dialog[open]").waitFor();
      await c.frame.locator("dialog").evaluate(() => window.__d.close());
      await c.page.waitForTimeout(200);
      assert.equal(await c.frame.locator("#opener").evaluate(
        (el) => document.activeElement === el), true,
        "focus was left nowhere, which strands anyone not using a pointer");
    } finally { await c.close(); }
  });
}
