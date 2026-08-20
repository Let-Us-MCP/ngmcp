import test from "node:test";
import assert from "node:assert/strict";
import { mount, VIEW } from "./component-harness.mjs";

const ENGINES = (process.env.NGMCP_ENGINES ?? "chromium,webkit").split(",");
const I = `import { proposal, approvalCard, taskList, stream, signal } from "${VIEW}";`;

for (const engine of ENGINES) {
  const at = (n) => `[${engine}] ${n}`;

  /* Proposal: the agent proposes, the person decides. */

  const PROPOSAL = `${I}
    const current = signal("The renewal is on track.");
    window.__applied = null;
    const p = proposal({
      current,
      render: (v) => v,
      onAccept: (v) => { window.__applied = v; current.set(v); },
      onReject: (v) => { window.__rejected = v; },
    });
    document.getElementById("root").appendChild(p.el);
    window.__p = p; window.__current = current;`;

  test(at("nothing is shown until something is proposed"), async () => {
    const c = await mount(engine, PROPOSAL);
    try {
      assert.equal(await c.frame.locator(".proposal").isVisible(), false);
    } finally { await c.close(); }
  });

  test(at("proposing shows the change and applies nothing"), async () => {
    const c = await mount(engine, PROPOSAL);
    try {
      await c.frame.locator("#root").evaluate(() =>
        window.__p.propose("The renewal has slipped to the 21st.", "The vendor confirmed the delay."));
      await c.frame.locator(".proposal").waitFor({ state: "visible" });
      assert.match(await c.frame.locator(".proposal-current .proposal-text").textContent(), /on track/);
      assert.match(await c.frame.locator(".proposal-next .proposal-text").textContent(), /slipped/);
      assert.equal(await c.frame.locator("#root").evaluate(() => window.__applied), null,
        "proposing applied the change, so the review is decoration");
      assert.equal(await c.frame.locator("#root").evaluate(() => window.__current()),
        "The renewal is on track.");
    } finally { await c.close(); }
  });

  test(at("the rationale names who is asking and why"), async () => {
    const c = await mount(engine, PROPOSAL);
    try {
      await c.frame.locator("#root").evaluate(() =>
        window.__p.propose("x", "The vendor confirmed the delay."));
      const who = await c.frame.locator(".proposal-who").textContent();
      assert.match(who, /The agent proposes/);
      assert.match(who, /vendor confirmed/);
    } finally { await c.close(); }
  });

  test(at("accepting applies it, and only then"), async () => {
    const c = await mount(engine, PROPOSAL);
    try {
      await c.frame.locator("#root").evaluate(() => window.__p.propose("Slipped to the 21st."));
      await c.frame.locator(".proposal-accept").click();
      await c.frame.locator(".proposal").waitFor({ state: "hidden" });
      assert.equal(await c.frame.locator("#root").evaluate(() => window.__applied),
        "Slipped to the 21st.");
    } finally { await c.close(); }
  });

  test(at("rejecting discards it and leaves the value alone"), async () => {
    const c = await mount(engine, PROPOSAL);
    try {
      await c.frame.locator("#root").evaluate(() => window.__p.propose("Nope."));
      await c.frame.locator(".proposal-reject").click();
      await c.frame.locator(".proposal").waitFor({ state: "hidden" });
      assert.equal(await c.frame.locator("#root").evaluate(() => window.__applied), null);
      assert.equal(await c.frame.locator("#root").evaluate(() => window.__rejected), "Nope.");
    } finally { await c.close(); }
  });

  /* Approval: enough in front of you to decide. */

  const APPROVAL = (risk = "high") => `${I}
    window.__decided = null;
    const a = approvalCard({
      request: {
        id: "refund-8841",
        title: "Refund 1,240.00 USD",
        risk: "${risk}",
        consequence: "The money leaves today and cannot be recalled from here.",
        description: "Refund invoice 2026-0814 to Meridian Systems in full.",
        provenance: {
          askedBy: "the agent, in this conversation",
          onBehalfOf: "sam@meridian.example",
          tool: "billing.refund",
          arguments: "invoice=2026-0814 amount=1240.00 currency=USD",
          priorApprovals: "none for this customer",
        },
      },
      onDecide: (d) => { window.__decided = d; window.__count = (window.__count || 0) + 1; },
    });
    document.getElementById("root").appendChild(a.el);
    window.__a = a;
    window.__count = 0;`;

  test(at("the card shows the provenance, not just the question"), async () => {
    const c = await mount(engine, APPROVAL());
    try {
      const text = await c.frame.locator(".approval-provenance").textContent();
      assert.match(text, /the agent, in this conversation/);
      assert.match(text, /sam@meridian.example/);
      assert.match(text, /billing.refund/);
      assert.match(text, /invoice=2026-0814 amount=1240.00/);
      assert.match(text, /none for this customer/);
    } finally { await c.close(); }
  });

  test(at("the consequence is stated, not buried"), async () => {
    const c = await mount(engine, APPROVAL());
    try {
      assert.match(await c.frame.locator(".approval-consequence").textContent(),
        /cannot be recalled/);
    } finally { await c.close(); }
  });

  test(at("a high-risk approval needs the title typed back"), async () => {
    const c = await mount(engine, APPROVAL("high"));
    try {
      assert.equal(await c.frame.locator(".approval-approve").isDisabled(), true);
      await c.frame.locator(".approval-confirm input").fill("Refund 1,240.00 USD");
      await c.frame.locator(".approval-approve:not([disabled])").waitFor();
      await c.frame.locator(".approval-approve").click();
      assert.equal(await c.frame.locator(".approval").evaluate(() => window.__decided), "approved");
    } finally { await c.close(); }
  });

  test(at("the wrong text does not unlock a high-risk approval"), async () => {
    const c = await mount(engine, APPROVAL("high"));
    try {
      await c.frame.locator(".approval-confirm input").fill("Refund 1240 USD");
      assert.equal(await c.frame.locator(".approval-approve").isDisabled(), true);
    } finally { await c.close(); }
  });

  test(at("a low-risk approval does not demand ceremony"), async () => {
    const c = await mount(engine, APPROVAL("low"));
    try {
      assert.equal(await c.frame.locator(".approval-confirm").count(), 0);
      assert.equal(await c.frame.locator(".approval-approve").isDisabled(), false);
    } finally { await c.close(); }
  });

  test(at("a decided request cannot be decided again, by any route"), async () => {
    const c = await mount(engine, APPROVAL("low"));
    try {
      await c.frame.locator(".approval-deny").click();
      assert.equal(await c.frame.locator(".approval").evaluate(() => window.__decided), "denied");
      // Straight at the decision, not through the button that disabled itself.
      await c.frame.locator(".approval").evaluate(async () => {
        await window.__a.decide("approved");
        await window.__a.decide("denied");
      });
      assert.equal(await c.frame.locator(".approval").evaluate(() => window.__decided), "denied",
        "a denied request was approved afterwards");
      assert.equal(await c.frame.locator(".approval").evaluate(() => window.__count), 1,
        "the decision fired more than once");
    } finally { await c.close(); }
  });

  test(at("denying is always available and needs no ceremony"), async () => {
    const c = await mount(engine, APPROVAL("high"));
    try {
      assert.equal(await c.frame.locator(".approval-deny").isDisabled(), false);
      await c.frame.locator(".approval-deny").click();
      assert.equal(await c.frame.locator(".approval").evaluate(() => window.__decided), "denied");
      assert.equal(await c.frame.locator(".approval-approve").isDisabled(), true,
        "a decided request must not be decidable twice");
    } finally { await c.close(); }
  });

  /* Tasks: progress that does not lie. */

  const TASKS = `${I}
    const tasks = signal([
      { id: "t1", name: "Reindex", state: "running", percent: 60, steps: ["a", "b", "c"] },
      { id: "t2", name: "Backfill", state: "failed", percent: 30, detail: "Upstream 503." },
    ]);
    window.__cancelled = null;
    const t = taskList({ tasks,
      onCancel: (task) => {
        window.__cancelled = task.id;
        tasks.set(tasks().map((x) => x.id === task.id
          ? { ...x, state: "cancelled", detail: "Stopped after 3 of 5 steps. Completed steps were not rolled back." }
          : x));
      },
      onRetry: (task) => { window.__retried = task.id; } });
    document.getElementById("root").appendChild(t.el);
    window.__tasks = tasks;`;

  test(at("a task shows its progress as a real progressbar"), async () => {
    const c = await mount(engine, TASKS);
    try {
      const bar = c.frame.locator('[role="progressbar"]').first();
      assert.equal(await bar.getAttribute("aria-valuenow"), "60");
      assert.equal(await bar.getAttribute("aria-valuemin"), "0");
      assert.equal(await bar.getAttribute("aria-valuemax"), "100");
      assert.match(await bar.getAttribute("aria-label"), /Reindex/);
    } finally { await c.close(); }
  });

  test(at("cancelling does not roll progress back to zero"), async () => {
    const c = await mount(engine, TASKS);
    try {
      await c.frame.locator('[data-id="t1"] .task-cancel').click();
      await c.frame.locator('[data-id="t1"].task-cancelled').waitFor();
      assert.equal(await c.frame.locator('[data-id="t1"] [role="progressbar"]')
        .getAttribute("aria-valuenow"), "60",
        "progress went back to zero, which says nothing happened");
      assert.match(await c.frame.locator('[data-id="t1"] .task-detail').textContent(),
        /not rolled back/);
    } finally { await c.close(); }
  });

  test(at("only a stoppable task offers cancel, only a stopped one offers retry"), async () => {
    const c = await mount(engine, TASKS);
    try {
      assert.equal(await c.frame.locator('[data-id="t1"] .task-cancel').count(), 1);
      assert.equal(await c.frame.locator('[data-id="t1"] .task-retry').count(), 0);
      assert.equal(await c.frame.locator('[data-id="t2"] .task-cancel').count(), 0);
      assert.equal(await c.frame.locator('[data-id="t2"] .task-retry').count(), 1);
    } finally { await c.close(); }
  });

  /* Stream: output faster than anyone can read. */

  const STREAM = `${I}
    const s = stream({ announceEveryMs: 150, max: 20 });
    document.getElementById("root").appendChild(s.el);
    window.__s = s;`;

  test(at("the log is not a live region"), async () => {
    const c = await mount(engine, STREAM);
    try {
      assert.equal(await c.frame.locator(".stream-lines").getAttribute("aria-live"), "off",
        "at five lines a second a polite region reads everything aloud");
      assert.equal(await c.frame.locator(".stream-lines").getAttribute("role"), "log");
    } finally { await c.close(); }
  });

  test(at("a burst is summarised, with the errors counted"), async () => {
    const c = await mount(engine, STREAM);
    try {
      await c.frame.locator(".stream").evaluate(() => {
        for (let i = 0; i < 12; i += 1) window.__s.append("line " + i);
        window.__s.append("connection reset", "error");
        window.__s.append("connection reset", "error");
      });
      await c.page.waitForTimeout(320);
      const spoken = await c.frame.locator(".stream [role=status]").textContent();
      assert.match(spoken, /14 new lines/);
      assert.match(spoken, /2 errors/);
    } finally { await c.close(); }
  });

  test(at("nothing is announced when nothing arrived"), async () => {
    const c = await mount(engine, STREAM);
    try {
      await c.page.waitForTimeout(320);
      assert.equal(await c.frame.locator(".stream [role=status]").textContent(), "");
    } finally { await c.close(); }
  });

  test(at("the oldest lines are dropped past the maximum"), async () => {
    const c = await mount(engine, STREAM);
    try {
      await c.frame.locator(".stream").evaluate(() => {
        for (let i = 0; i < 30; i += 1) window.__s.append("line " + i);
      });
      assert.equal(await c.frame.locator(".stream-line").count(), 20);
      assert.match(await c.frame.locator(".stream-line").last().textContent(), /line 29/);
    } finally { await c.close(); }
  });
}
