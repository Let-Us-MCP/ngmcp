import test from "node:test";
import assert from "node:assert/strict";
import { mount, VIEW } from "./component-harness.mjs";

const ENGINES = (process.env.NGMCP_ENGINES ?? "chromium,webkit").split(",");

const ROWS = `[
  { id: "d1", service: "checkout",      env: "production", errors: 143 },
  { id: "d2", service: "billing",       env: "production", errors: 12 },
  { id: "d3", service: "search",        env: "staging",    errors: 0 },
  { id: "d4", service: "notifications", env: "canary",     errors: 7 }
]`;

const COLUMNS = `[
  { key: "service", label: "Service" },
  { key: "env",     label: "Env" },
  { key: "errors",  label: "Errors", align: "end" }
]`;

const IMPORT = `import { dataTable } from "${VIEW}";`;

const build = (extra = "") => `
  ${IMPORT}
  const table = dataTable({
    rows: ${ROWS},
    columns: ${COLUMNS},
    selection: "multiple",
    ${extra}
  });
  document.getElementById("root").appendChild(table.el);
  window.__table = table;
`;

for (const engine of ENGINES) {
  const at = (name) => `[${engine}] ${name}`;

  test(at("renders every row and column it was given"), async () => {
    const c = await mount(engine, build());
    try {
      assert.equal(await c.frame.locator("tbody tr").count(), 4);
      assert.equal(await c.frame.locator("thead th").count(), 3);
      assert.match(await c.frame.locator("tbody tr").first().textContent(), /checkout/);
      assert.equal(await c.frame.locator(".status").textContent(), "4 rows");
    } finally { await c.close(); }
  });

  test(at("filtering happens locally and narrows the rows"), async () => {
    const c = await mount(engine, build());
    try {
      await c.frame.locator(".filter").fill("bill");
      await c.frame.locator(".status").filter({ hasText: "1 of 4" }).waitFor();
      assert.equal(await c.frame.locator("tbody tr").count(), 1);
      await c.frame.locator(".filter").fill("");
      await c.frame.locator(".status").filter({ hasText: "4 rows" }).waitFor();
      assert.equal(await c.frame.locator("tbody tr").count(), 4);
    } finally { await c.close(); }
  });

  test(at("filtering matches any column, not only the first"), async () => {
    const c = await mount(engine, build());
    try {
      await c.frame.locator(".filter").fill("canary");
      await c.frame.locator(".status").filter({ hasText: "1 of 4" }).waitFor();
      assert.match(await c.frame.locator("tbody tr").first().textContent(), /notifications/);
    } finally { await c.close(); }
  });

  test(at("a column sorts, reverses, and says which way in aria-sort"), async () => {
    const c = await mount(engine, build());
    try {
      const header = c.frame.locator("thead th").nth(2);
      assert.equal(await header.getAttribute("aria-sort"), "none");
      await header.locator("button").click();
      assert.equal(await header.getAttribute("aria-sort"), "ascending");
      assert.match(await c.frame.locator("tbody tr").first().textContent(), /search/);
      await header.locator("button").click();
      assert.equal(await header.getAttribute("aria-sort"), "descending");
      assert.match(await c.frame.locator("tbody tr").first().textContent(), /checkout/);
    } finally { await c.close(); }
  });

  test(at("numbers sort as numbers, not as strings"), async () => {
    const c = await mount(engine, build());
    try {
      await c.frame.locator("thead th").nth(2).locator("button").click();
      const order = await c.frame.locator("tbody tr td.num").allTextContents();
      assert.deepEqual(order, ["0", "7", "12", "143"],
        "12 sorted after 143 means it compared as text");
    } finally { await c.close(); }
  });

  test(at("only one column carries aria-sort at a time"), async () => {
    const c = await mount(engine, build());
    try {
      await c.frame.locator("thead th").nth(0).locator("button").click();
      await c.frame.locator("thead th").nth(2).locator("button").click();
      assert.equal(await c.frame.locator('thead th[aria-sort="ascending"]').count(), 1);
      assert.equal(await c.frame.locator('thead th[aria-sort="none"]').count(), 2);
    } finally { await c.close(); }
  });

  test(at("a row selects with the pointer and reports it"), async () => {
    const c = await mount(engine, build());
    try {
      await c.frame.locator("tbody tr").first().click();
      assert.equal(await c.frame.locator('tbody tr[aria-selected="true"]').count(), 1);
      await c.frame.locator(".status").filter({ hasText: "1 selected" }).waitFor();
    } finally { await c.close(); }
  });

  test(at("a row selects from the keyboard alone, with Enter and Space"), async () => {
    const c = await mount(engine, build());
    try {
      await c.frame.locator("tbody tr").nth(1).focus();
      await c.page.keyboard.press("Enter");
      assert.equal(await c.frame.locator('tbody tr[aria-selected="true"]').count(), 1);
      await c.frame.locator("tbody tr").nth(2).focus();
      await c.page.keyboard.press(" ");
      assert.equal(await c.frame.locator('tbody tr[aria-selected="true"]').count(), 2);
    } finally { await c.close(); }
  });

  test(at("the header sort button is reachable by keyboard"), async () => {
    const c = await mount(engine, build());
    try {
      await c.frame.locator("thead th").nth(0).locator("button").focus();
      await c.page.keyboard.press("Enter");
      assert.equal(await c.frame.locator("thead th").nth(0).getAttribute("aria-sort"), "ascending");
    } finally { await c.close(); }
  });

  test(at("selection survives filtering the row out and back"), async () => {
    const c = await mount(engine, build());
    try {
      await c.frame.locator('tbody tr[data-id="d2"]').click();
      await c.frame.locator(".filter").fill("checkout");
      await c.frame.locator(".status").filter({ hasText: "1 of 4" }).waitFor();
      await c.frame.locator(".filter").fill("");
      await c.frame.locator(".status").filter({ hasText: "4 rows" }).waitFor();
      assert.equal(await c.frame.locator('tbody tr[data-id="d2"]')
        .getAttribute("aria-selected"), "true",
        "selection was dropped when the row left the view");
    } finally { await c.close(); }
  });

  test(at("paging shows a page at a time and stops at both ends"), async () => {
    const c = await mount(engine, build("pageSize: 2,"));
    try {
      assert.equal(await c.frame.locator("tbody tr").count(), 2);
      assert.equal(await c.frame.locator(".page-label").textContent(), "Page 1 of 2");
      assert.equal(await c.frame.locator('button[aria-label="Previous page"]').isDisabled(), true);
      await c.frame.locator('button[aria-label="Next page"]').click();
      assert.equal(await c.frame.locator(".page-label").textContent(), "Page 2 of 2");
      assert.equal(await c.frame.locator('button[aria-label="Next page"]').isDisabled(), true);
      assert.match(await c.frame.locator("tbody tr").first().textContent(), /search/);
    } finally { await c.close(); }
  });

  test(at("filtering returns to the first page"), async () => {
    const c = await mount(engine, build("pageSize: 2,"));
    try {
      await c.frame.locator('button[aria-label="Next page"]').click();
      assert.equal(await c.frame.locator(".page-label").textContent(), "Page 2 of 2");
      await c.frame.locator(".filter").fill("o");
      await c.frame.locator(".page-label").filter({ hasText: "Page 1" }).waitFor();
    } finally { await c.close(); }
  });

  test(at("an empty result says so rather than showing an empty table"), async () => {
    const c = await mount(engine, build());
    try {
      await c.frame.locator(".filter").fill("nothing matches this");
      await c.frame.locator(".status").filter({ hasText: "0 of 4" }).waitFor();
      assert.equal(await c.frame.locator("tbody tr").count(), 0);
    } finally { await c.close(); }
  });

  test(at("the table is a table, and the status is a live region"), async () => {
    const c = await mount(engine, build());
    try {
      assert.equal(await c.frame.locator("table thead th[scope='col']").count(), 3);
      assert.equal(await c.frame.locator(".status").getAttribute("aria-live"), "polite");
      assert.equal(await c.frame.locator(".status").getAttribute("role"), "status");
      assert.equal(await c.frame.locator(".filter").getAttribute("aria-label"), "Filter rows");
    } finally { await c.close(); }
  });
}
