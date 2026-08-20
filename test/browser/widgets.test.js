import test from "node:test";
import assert from "node:assert/strict";
import { mount, VIEW } from "./component-harness.mjs";

const ENGINES = (process.env.NGMCP_ENGINES ?? "chromium,webkit").split(",");
const I = `import { button, form } from "${VIEW}";`;

const FORM_SRC = `${I}
  const f = form({
    fields: [
      { name: "invoice", label: "Invoice", required: true },
      { name: "amount", label: "Amount", type: "number", required: true,
        validate: (v) => Number(v) > 1000 ? "Over the limit." : undefined },
      { name: "reason", label: "Reason", type: "textarea" },
    ],
    submitLabel: "Refund",
    onSubmit: (values) => { window.__submitted = values; },
  });
  document.getElementById("root").appendChild(f.el);
  window.__f = f;`;

for (const engine of ENGINES) {
  const at = (n) => `[${engine}] ${n}`;

  /* Button: the three host states. */

  test(at("granted: the button runs its operation"), async () => {
    const c = await mount(engine, `${I}
      const b = button({ label: "Export", requires: "downloadFile",
        capabilities: { downloadFile: {} },
        onActivate: () => { window.__ran = true; } });
      document.getElementById("root").appendChild(b.el);`);
    try {
      await c.frame.locator(".btn").first().click();
      assert.equal(await c.frame.locator(".btn").first().evaluate(() => window.__ran), true);
      assert.match(await c.frame.locator(".btn").first().getAttribute("class"), /btn-granted/);
    } finally { await c.close(); }
  });

  test(at("absent: the button says so and offers the fallback"), async () => {
    const c = await mount(engine, `${I}
      const b = button({ label: "Export", requires: "downloadFile",
        capabilities: {},
        unavailableLabel: "Export unavailable",
        fallback: { label: "Copy instead", onActivate: () => { window.__copied = true; } },
        onActivate: () => {} });
      document.getElementById("root").appendChild(b.el);`);
    try {
      assert.equal(await c.frame.locator(".btn").first().textContent(), "Export unavailable");
      assert.equal(await c.frame.locator(".btn-fallback").isVisible(), true);
      await c.frame.locator(".btn-fallback").click();
      assert.equal(await c.frame.locator(".btn-fallback").evaluate(() => window.__copied), true);
    } finally { await c.close(); }
  });

  test(at("refused: the failure is shown, never swallowed"), async () => {
    const c = await mount(engine, `${I}
      const b = button({ label: "Export", requires: "downloadFile",
        capabilities: { downloadFile: {} },
        onActivate: () => { throw new Error("The host declined to save that."); } });
      document.getElementById("root").appendChild(b.el);`);
    try {
      await c.frame.locator(".btn").first().click();
      await c.frame.locator(".button-error").waitFor({ state: "visible" });
      assert.match(await c.frame.locator(".button-error").textContent(), /declined to save/,
        "a silent refusal is the default failure this component exists to prevent");
      assert.match(await c.frame.locator(".btn").first().getAttribute("class"), /btn-refused/);
    } finally { await c.close(); }
  });

  test(at("an unknown host is not pre-emptively disabled"), async () => {
    const c = await mount(engine, `${I}
      const b = button({ label: "Export", requires: "downloadFile",
        onActivate: () => { window.__ran = true; } });
      document.getElementById("root").appendChild(b.el);`);
    try {
      assert.equal(await c.frame.locator(".btn").first().textContent(), "Export");
      await c.frame.locator(".btn").first().click();
      assert.equal(await c.frame.locator(".btn").first().evaluate(() => window.__ran), true);
    } finally { await c.close(); }
  });

  test(at("a slow operation marks itself busy and cannot double fire"), async () => {
    const c = await mount(engine, `${I}
      let calls = 0;
      const b = button({ label: "Save", onActivate: async () => {
        calls += 1; window.__calls = calls;
        await new Promise((r) => setTimeout(r, 250));
      } });
      document.getElementById("root").appendChild(b.el);`);
    try {
      const btn = c.frame.locator(".btn").first();
      await btn.click();
      assert.equal(await btn.getAttribute("aria-busy"), "true");
      assert.equal(await btn.isDisabled(), true);
      await c.page.waitForTimeout(350);
      assert.equal(await btn.evaluate(() => window.__calls), 1);
    } finally { await c.close(); }
  });

  /* Form: prefill is not submission. */

  const FORM = FORM_SRC;

  test(at("an agent prefilling the form does not submit it"), async () => {
    const c = await mount(engine, FORM);
    try {
      await c.frame.locator("form").evaluate(() =>
        window.__f.prefill({ invoice: "2026-0814", amount: "240" }));
      assert.equal(await c.frame.locator("#f-invoice").inputValue(), "2026-0814");
      assert.equal(await c.frame.locator("form").evaluate(() => window.__submitted), undefined,
        "prefilling submitted the form, which hands the decision to the agent");
    } finally { await c.close(); }
  });

  test(at("prefilled fields are marked and named, so a person can check them"), async () => {
    const c = await mount(engine, FORM);
    try {
      await c.frame.locator("form").evaluate(() =>
        window.__f.prefill({ invoice: "2026-0814", amount: "240" }));
      await c.frame.locator(".form-notice").waitFor({ state: "visible" });
      const notice = await c.frame.locator(".form-notice").textContent();
      assert.match(notice, /Invoice/);
      assert.match(notice, /Amount/);
      assert.match(notice, /not submitted/i);
      assert.equal(await c.frame.locator('[data-prefilled="true"]').count(), 2);
    } finally { await c.close(); }
  });

  test(at("editing a prefilled field clears its mark: it is yours now"), async () => {
    const c = await mount(engine, FORM);
    try {
      await c.frame.locator("form").evaluate(() =>
        window.__f.prefill({ invoice: "2026-0814", amount: "240" }));
      await c.frame.locator("#f-invoice").fill("2026-0999");
      assert.equal(await c.frame.locator('[data-prefilled="true"]').count(), 1);
    } finally { await c.close(); }
  });

  test(at("a person submitting a prefilled form does submit it"), async () => {
    const c = await mount(engine, FORM);
    try {
      await c.frame.locator("form").evaluate(() =>
        window.__f.prefill({ invoice: "2026-0814", amount: "240" }));
      await c.frame.locator('.form-actions .btn-primary').click();
      const submitted = await c.frame.locator("form").evaluate(() => window.__submitted);
      assert.equal(submitted.invoice, "2026-0814");
    } finally { await c.close(); }
  });

  test(at("required fields block submission and are announced"), async () => {
    const c = await mount(engine, FORM);
    try {
      await c.frame.locator('.form-actions .btn-primary').click();
      assert.equal(await c.frame.locator("form").evaluate(() => window.__submitted), undefined);
      assert.equal(await c.frame.locator("#f-invoice").getAttribute("aria-invalid"), "true");
      assert.match(await c.frame.locator("#f-invoice-error").textContent(), /required/);
      assert.match(await c.frame.locator("#f-invoice").getAttribute("aria-describedby"), /f-invoice-error/);
    } finally { await c.close(); }
  });

  test(at("a custom validator rejects and says why"), async () => {
    const c = await mount(engine, FORM);
    try {
      await c.frame.locator("#f-invoice").fill("x");
      await c.frame.locator("#f-amount").fill("5000");
      await c.frame.locator('.form-actions .btn-primary').click();
      assert.match(await c.frame.locator("#f-amount-error").textContent(), /Over the limit/);
      assert.equal(await c.frame.locator("form").evaluate(() => window.__submitted), undefined);
    } finally { await c.close(); }
  });

  test(at("every field has a label bound to its control"), async () => {
    const c = await mount(engine, FORM);
    try {
      for (const name of ["invoice", "amount", "reason"]) {
        assert.equal(await c.frame.locator(`label[for="f-${name}"]`).count(), 1,
          `${name} has no label bound to it`);
      }
    } finally { await c.close(); }
  });
}

/* The sandbox constraint that shaped the component above.
 *
 * Chromium refuses outright: "Blocked form submission because the form's frame
 * is sandboxed and the 'allow-forms' permission is not set." WebKit lets the
 * event fire. The MCP Apps sandbox is `allow-scripts` and `allow-same-origin`,
 * with no `allow-forms`, so a view that submits natively works in one engine
 * and silently does nothing in the other. That is worse than a failure, and it
 * is why form.ts wires submission by hand. */
for (const engine of ENGINES) {
  test(`[${engine}] native form submission is not portable, so it is not used`, async () => {
    const c = await mount(engine, `
      const f = document.createElement("form");
      f.innerHTML = '<button type="submit" id="native">go</button>';
      f.addEventListener("submit", (e) => { e.preventDefault(); window.__fired = true; });
      document.getElementById("root").appendChild(f);
      window.__fired = false;`);
    try {
      await c.frame.locator("#native").click();
      await c.page.waitForTimeout(200);
      const fired = await c.frame.locator("#native").evaluate(() => window.__fired);
      if (engine === "chromium") {
        assert.equal(fired, false, "Chromium used to block this; allow-forms may now be granted");
      }
      // WebKit fires it. Recorded rather than asserted, because the point is
      // that the two disagree and neither can be depended on.
      assert.equal(typeof fired, "boolean");
    } finally { await c.close(); }
  });

  test(`[${engine}] our form submits without needing allow-forms`, async () => {
    const c = await mount(engine, FORM_SRC);
    try {
      await c.frame.locator("#f-invoice").fill("2026-1");
      await c.frame.locator("#f-amount").fill("10");
      await c.frame.locator(".form-actions .btn-primary").click();
      const submitted = await c.frame.locator("form").evaluate(() => window.__submitted);
      assert.equal(submitted.invoice, "2026-1");
    } finally { await c.close(); }
  });

  test(`[${engine}] Enter in a single-line field submits, as a native form would`, async () => {
    const c = await mount(engine, FORM_SRC);
    try {
      await c.frame.locator("#f-invoice").fill("2026-2");
      await c.frame.locator("#f-amount").fill("5");
      await c.frame.locator("#f-amount").press("Enter");
      const submitted = await c.frame.locator("form").evaluate(() => window.__submitted);
      assert.equal(submitted.invoice, "2026-2");
    } finally { await c.close(); }
  });
}
