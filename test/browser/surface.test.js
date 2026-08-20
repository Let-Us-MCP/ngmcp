import test from "node:test";
import assert from "node:assert/strict";
import { mount, VIEW } from "./component-harness.mjs";

const ENGINES = (process.env.NGMCP_ENGINES ?? "chromium,webkit").split(",");
const I = `import { surface, h, signal } from "${VIEW}";`;

/* A Surface is the host relationship, so its tests are about what the host
 * does rather than about what is drawn: capabilities it never offered, calls
 * it refuses, context it changes underneath the view, and the handshake it
 * runs before taking the view away.
 *
 * The host here is a stub inside the frame rather than the parent page,
 * because what is under test is how the view behaves when a host says no, and
 * a real parent that always says yes cannot show that. */
const HOST = `
  window.__sent = [];
  window.__refuse = new Set();
  window.__listeners = new Set();
  const bridge = {
    callServerTool: async () => ({}),
    callHost: async (method, params) => {
      window.__sent.push({ method, params });
      if (window.__refuse.has(method)) throw new Error("The host refused that.");
      return { ok: method };
    },
    onHost: (handler) => { window.__listeners.add(handler); return () => window.__listeners.delete(handler); },
    reply: (id, result) => { window.__replies = window.__replies || []; window.__replies.push({ id, result }); },
  };
  window.__emit = (event) => { for (const l of window.__listeners) l(event); };`;

for (const engine of ENGINES) {
  const at = (n) => `[${engine}] ${n}`;

  const build = (extra = "", caps = `{ openLink: {}, downloadFile: {}, sendSizeChanged: {} }`) => `${I}
    ${HOST}
    const s = surface({
      bridge,
      capabilities: ${caps},
      context: { locale: "en-GB", theme: "dark", displayMode: "inline",
                 safeArea: { top: 44, bottom: 34 } },
      reportSize: false,
    });
    window.__s = s;
    ${extra}`;

  test(at("granted: the host has it, was asked, and did it"), async () => {
    const c = await mount(engine, build());
    try {
      const outcome = await c.frame.locator("#root").evaluate(
        () => window.__s.openLink("https://example.com/runbook"));
      assert.equal(outcome, "granted");
      const sent = await c.frame.locator("#root").evaluate(() => window.__sent);
      assert.deepEqual(sent, [
        { method: "openLink", params: { url: "https://example.com/runbook" } }]);
    } finally { await c.close(); }
  });

  test(at("absent: a capability the host never offered is not asked for"), async () => {
    /* Asking anyway produces a rejection that reads like a refusal, and the
     * two want different handling: absent takes a fallback, refused takes an
     * explanation. */
    const c = await mount(engine, build());
    try {
      const outcome = await c.frame.locator("#root").evaluate(
        () => window.__s.sendMessage("Restarted checkout"));
      assert.equal(outcome, "absent");
      const sent = await c.frame.locator("#root").evaluate(() => window.__sent);
      assert.deepEqual(sent, [], "the view asked a host that never offered it");
      assert.equal(await c.frame.locator("#root").evaluate(() => window.__s.has("sendMessage")), false);
    } finally { await c.close(); }
  });

  test(at("refused: the host was asked and said no, with its reason"), async () => {
    const c = await mount(engine, build(`window.__refuse.add("openLink");`));
    try {
      const outcome = await c.frame.locator("#root").evaluate(
        () => window.__s.openLink("https://example.com"));
      assert.equal(outcome, "refused");
      const refusals = await c.frame.locator("#root").evaluate(() => window.__s.refusals());
      assert.equal(refusals.length, 1);
      assert.equal(refusals[0].capability, "openLink");
      assert.equal(refusals[0].outcome, "refused");
      assert.match(refusals[0].reason, /refused/);
    } finally { await c.close(); }
  });

  test(at("a refusal is never a thrown error the view has to catch"), async () => {
    /* Silence on refusal is the default failure. A promise that rejects makes
     * silence the easiest thing to write. */
    const c = await mount(engine, build(`window.__refuse.add("downloadFile");`));
    try {
      const result = await c.frame.locator("#root").evaluate(async () => {
        try {
          return { threw: false, outcome: await window.__s.downloadFile(
            { name: "rows.csv", mimeType: "text/csv", contents: "a,b" }) };
        } catch (error) { return { threw: true, message: String(error) }; }
      });
      assert.deepEqual(result, { threw: false, outcome: "refused" });
    } finally { await c.close(); }
  });

  test(at("the three situations are kept apart in the record"), async () => {
    const c = await mount(engine, build(`window.__refuse.add("openLink");`));
    try {
      const outcomes = await c.frame.locator("#root").evaluate(async () => [
        await window.__s.openLink("https://example.com"),
        await window.__s.sendMessage("hello"),
        await window.__s.request("sendSizeChanged", { height: 100 }),
      ]);
      assert.deepEqual(outcomes, ["refused", "absent", "granted"]);
      const refusals = await c.frame.locator("#root").evaluate(() => window.__s.refusals());
      assert.deepEqual(refusals.map((r) => [r.capability, r.outcome]),
        [["openLink", "refused"], ["sendMessage", "absent"]]);
    } finally { await c.close(); }
  });

  test(at("the host's context reaches CSS, so a notch is not drawn under"), async () => {
    const c = await mount(engine, build());
    try {
      const applied = await c.frame.locator("#root").evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        return {
          top: style.getPropertyValue("--safe-area-top").trim(),
          bottom: style.getPropertyValue("--safe-area-bottom").trim(),
          mode: document.documentElement.dataset.displayMode,
          theme: document.documentElement.dataset.theme,
        };
      });
      assert.deepEqual(applied,
        { top: "44px", bottom: "34px", mode: "inline", theme: "dark" });
    } finally { await c.close(); }
  });

  test(at("the host changes the context underneath and the view follows"), async () => {
    const c = await mount(engine, build());
    try {
      await c.frame.locator("#root").evaluate(() => window.__emit(
        { type: "displayMode", data: "fullscreen" }));
      // A host sends what changed, not the whole context. Everything it did
      // not mention has to survive, or a theme switch takes the insets and the
      // display mode with it.
      await c.frame.locator("#root").evaluate(() => window.__emit({
        type: "hostContext", data: { theme: "light", locale: "fr-FR" },
      }));
      const after = await c.frame.locator("#root").evaluate(() => ({
        theme: window.__s.theme(),
        locale: window.__s.locale(),
        top: getComputedStyle(document.documentElement)
          .getPropertyValue("--safe-area-top").trim(),
        mode: window.__s.displayMode(),
      }));
      assert.deepEqual(after,
        { theme: "light", locale: "fr-FR", top: "44px", mode: "fullscreen" });
    } finally { await c.close(); }
  });

  test(at("display mode is asked for and then arrives as an event"), async () => {
    const c = await mount(engine, build());
    try {
      const outcome = await c.frame.locator("#root").evaluate(
        () => window.__s.requestDisplayMode("fullscreen"));
      // Asking is not being granted: the host answers separately, because it
      // may put the view back inline without being asked at all.
      assert.equal(outcome, "absent");
      await c.frame.locator("#root").evaluate(() => window.__emit(
        { type: "displayMode", data: "fullscreen" }));
      assert.equal(await c.frame.locator("#root").evaluate(
        () => window.__s.displayMode()), "fullscreen");
      assert.equal(await c.frame.locator("#root").evaluate(
        () => document.documentElement.dataset.displayMode), "fullscreen");
    } finally { await c.close(); }
  });

  test(at("the teardown handshake asks before the view is taken away"), async () => {
    const c = await mount(engine, build(`
      window.__ran = [];
      s.onTeardown(() => { window.__ran.push("flush"); return true; });`));
    try {
      await c.frame.locator("#root").evaluate(() =>
        window.__emit({ type: "teardown", id: "t1" }));
      await c.page.waitForTimeout(50);
      const state = await c.frame.locator("#root").evaluate(() => ({
        ran: window.__ran, replies: window.__replies,
      }));
      assert.deepEqual(state.ran, ["flush"]);
      assert.deepEqual(state.replies, [{ id: "t1", result: { ready: true } }]);
    } finally { await c.close(); }
  });

  test(at("one objection is enough, and it is a request rather than a veto"), async () => {
    const c = await mount(engine, build(`
      s.onTeardown(() => true);
      s.onTeardown(() => false);
      s.onTeardown(() => true);`));
    try {
      await c.frame.locator("#root").evaluate(() =>
        window.__emit({ type: "teardown", id: "t2" }));
      await c.page.waitForTimeout(50);
      const replies = await c.frame.locator("#root").evaluate(() => window.__replies);
      assert.deepEqual(replies, [{ id: "t2", result: { ready: false } }],
        "an unsaved change did not reach the host");
    } finally { await c.close(); }
  });

  test(at("a teardown handler that throws counts as an objection"), async () => {
    const c = await mount(engine, build(`
      s.onTeardown(() => { throw new Error("could not flush"); });`));
    try {
      await c.frame.locator("#root").evaluate(() =>
        window.__emit({ type: "teardown", id: "t3" }));
      await c.page.waitForTimeout(50);
      const replies = await c.frame.locator("#root").evaluate(() => window.__replies);
      assert.deepEqual(replies, [{ id: "t3", result: { ready: false } }]);
    } finally { await c.close(); }
  });

  test(at("the host is told the size, in the units it asked in"), async () => {
    const c = await mount(engine, build(`window.__s.sendSizeChanged(480);`));
    try {
      const sent = await c.frame.locator("#root").evaluate(() => window.__sent);
      assert.deepEqual(sent, [{ method: "sendSizeChanged", params: { height: 480 } }]);
    } finally { await c.close(); }
  });

  test(at("a host that offers nothing is a host, not an error"), async () => {
    const c = await mount(engine, build("", "{}"));
    try {
      const outcomes = await c.frame.locator("#root").evaluate(async () => [
        await window.__s.openLink("https://example.com"),
        await window.__s.requestTeardown(),
      ]);
      assert.deepEqual(outcomes, ["absent", "absent"]);
      assert.deepEqual(await c.frame.locator("#root").evaluate(() => window.__sent), []);
    } finally { await c.close(); }
  });
}
