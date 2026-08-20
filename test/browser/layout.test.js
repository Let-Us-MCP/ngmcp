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
      // What the id is does not matter; what it reaches does.
      assert.equal(await c.frame.locator('[role="tab"]').first().evaluate((tab) => {
        const panel = tab.ownerDocument.getElementById(tab.getAttribute("aria-controls"));
        return panel?.getAttribute("role");
      }), "tabpanel");
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

  test(at("a dialog opens modally and is labelled by its own title"), async () => {
    const c = await mount(engine, DIALOG);
    try {
      await c.frame.locator("#opener").click();
      await c.frame.locator("dialog[open]").waitFor();
      assert.equal(await c.frame.locator("dialog").evaluate((d) => d.open), true);
      // The relationship, not the literal id. Asserting the id passes for a
      // dialog whose name resolves to somebody else's heading.
      const named = await c.frame.locator("dialog").evaluate((d) => {
        const target = d.ownerDocument.getElementById(d.getAttribute("aria-labelledby"));
        return { text: target?.textContent, isOwn: d.contains(target) };
      });
      assert.equal(named.text, "Delete four files?");
      assert.equal(named.isOwn, true, "the dialog is named by another element's heading");
    } finally { await c.close(); }
  });

  test(at("a second dialog is named by its own title, not the first one's"), async () => {
    /* A view holds as many dialogs as it has decisions to ask about, and a
     * component that mints a fixed id works alone and misnames itself the
     * moment there are two. */
    const c = await mount(engine, `${I}
      const root = document.getElementById("root");
      const first = dialog({ title: "Delete four files?",
        content: h("p", { text: "One." }), onClose: () => {} });
      const second = dialog({ title: "Restart checkout?",
        content: h("p", { text: "Two." }), onClose: () => {} });
      root.appendChild(first.el); root.appendChild(second.el);
      window.__second = second;`);
    try {
      await c.frame.locator("#root").evaluate(() => window.__second.open());
      await c.frame.locator("dialog[open]").waitFor();
      const named = await c.frame.locator("dialog[open]").evaluate((d) => {
        const id = d.getAttribute("aria-labelledby");
        return {
          announced: d.ownerDocument.getElementById(id)?.textContent,
          shown: d.querySelector(".dialog-title").textContent,
          sharing: d.ownerDocument.querySelectorAll(`[id="${id}"]`).length,
        };
      });
      assert.equal(named.shown, "Restart checkout?");
      assert.equal(named.announced, "Restart checkout?",
        "the second dialog announced the first one's title");
      assert.equal(named.sharing, 1, "two elements answer to the same id");
    } finally { await c.close(); }
  });

  test(at("two tab groups with the same tab ids do not collide"), async () => {
    const c = await mount(engine, `${I}
      const root = document.getElementById("root");
      for (const label of ["Left", "Right"]) {
        root.appendChild(tabs({ label, tabs: [
          { id: "one", label: label + " one", content: () => h("p", { text: "1" }) },
          { id: "two", label: label + " two", content: () => h("p", { text: "2" }) },
        ] }).el);
      }`);
    try {
      const wiring = await c.frame.locator("#root").evaluate(() => {
        const tabsInGroups = [...document.querySelectorAll('[role="tab"]')];
        return tabsInGroups.map((tab) => {
          const id = tab.getAttribute("aria-controls");
          const panel = document.getElementById(id);
          return {
            sharing: document.querySelectorAll(`[id="${id}"]`).length,
            // The panel a tab points at has to be in the same tab group.
            sameGroup: tab.closest(".tabs") === panel?.closest(".tabs"),
          };
        });
      });
      assert.equal(wiring.length, 4);
      for (const tab of wiring) {
        assert.equal(tab.sharing, 1, "two panels answer to the same id");
        assert.equal(tab.sameGroup, true, "a tab controls the other group's panel");
      }
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
