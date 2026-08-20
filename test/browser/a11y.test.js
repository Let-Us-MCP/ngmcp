import test from "node:test";
import assert from "node:assert/strict";
import { mount, violations, reportable, VIEW } from "./component-harness.mjs";

/* Accessibility asserted rather than claimed.
 *
 * Every component states that it is accessible; this is the file where that
 * stops being prose. Each one is mounted alone, in the sandboxed frame it
 * actually runs in, and axe is run over it. Alone matters: an application that
 * uses a component can give it a name from a heading that happens to sit
 * nearby, and the component then ships with a hole its own tests never see.
 *
 * What axe cannot check is checked elsewhere. Keyboard routes, focus order and
 * the ARIA Authoring Practices key bindings are assertions in each component's
 * own suite, because no scanner presses arrow keys.
 */

const ENGINES = (process.env.NGMCP_ENGINES ?? "chromium,webkit").split(",");

const COMPONENTS = {
  "the data table, with paging, sorting and selection": `
    import { dataTable } from "${VIEW}";
    const table = dataTable({
      rows: [
        { id: "d1", service: "checkout", env: "production", errors: 143 },
        { id: "d2", service: "billing", env: "production", errors: 12 },
        { id: "d3", service: "search", env: "staging", errors: 0 },
      ],
      columns: [
        { key: "service", label: "Service" },
        { key: "env", label: "Environment" },
        { key: "errors", label: "Errors", align: "end" },
      ],
      selection: "multiple",
      pageSize: 2,
    });
    document.getElementById("root").appendChild(table.el);`,

  "a metric, with a delta and a state": `
    import { metric } from "${VIEW}";
    const root = document.getElementById("root");
    root.appendChild(metric({
      label: "Error rate", value: 143, unit: "/h", delta: -12, state: "bad",
      locale: "en-US",
    }).el);
    root.appendChild(metric({
      label: "Requests", value: 1234567, locale: "en-US",
      onActivate: () => {},
    }).el);`,

  "a form, with help, an error and a prefilled field": `
    import { form } from "${VIEW}";
    const f = form({
      fields: [
        { name: "invoice", label: "Invoice", required: true, help: "As printed." },
        { name: "amount", label: "Amount", type: "number", required: true },
        { name: "reason", label: "Reason", type: "textarea" },
        { name: "urgent", label: "Urgent", type: "checkbox" },
      ],
      submitLabel: "Refund",
      onSubmit: () => {},
    });
    document.getElementById("root").appendChild(f.el);
    f.prefill({ invoice: "2026-0814" });
    // Submitting with a required field empty, so the error state is what axe
    // sees: an unlabelled error is the one that matters and the one a passing
    // form never shows.
    f.el.querySelector(".form-actions button").click();`,

  "a button in each of the three host states": `
    import { button, stack } from "${VIEW}";
    const root = document.getElementById("root");
    root.appendChild(stack({},
      button({ label: "Export", requires: "downloadFile",
        capabilities: { downloadFile: {} }, onActivate: () => {} }).el,
      button({ label: "Download", requires: "downloadFile",
        capabilities: {}, onActivate: () => {} }).el,
      button({ label: "Restart", onActivate: () => { throw new Error("The host refused that."); } }).el));`,

  "a toast and a banner": `
    import { toaster, banner } from "${VIEW}";
    const root = document.getElementById("root");
    const notes = toaster({ timeoutMs: 0 });
    root.appendChild(notes.el);
    notes.show("Export finished", "success");
    notes.show("Two rows could not be read", "error");
    root.appendChild(banner({ text: "Read only.", tone: "warning", dismissible: true }).el);`,

  "the layouts, with a card, tabs and a divider": `
    import { stack, row, spacer, divider, columns, card, tabs, h } from "${VIEW}";
    const root = document.getElementById("root");
    root.appendChild(card({ title: "Deployments" }, h("p", { text: "Four services." })));
    root.appendChild(tabs({ label: "Sections", tabs: [
      { id: "one", label: "Summary", content: () => h("p", { text: "first" }) },
      { id: "two", label: "History", content: () => h("p", { text: "second" }) },
    ] }).el);
    root.appendChild(columns({}, h("p", { text: "left" }), h("p", { text: "right" })));
    root.appendChild(row({}, h("span", { text: "x" }), spacer(), h("span", { text: "y" })));
    root.appendChild(divider("Older"));`,

  "an open dialog": `
    import { dialog, h } from "${VIEW}";
    const d = dialog({
      title: "Delete four files?",
      content: h("p", { text: "This cannot be undone." }),
      actions: [h("button", { type: "button", text: "Delete" })],
      onClose: () => {},
    });
    document.getElementById("root").appendChild(d.el);
    d.open();`,

  "a proposal waiting to be decided": `
    import { proposal, signal } from "${VIEW}";
    const current = signal("The renewal is on track.");
    const p = proposal({
      current, render: (v) => v,
      onAccept: () => {}, onReject: () => {},
    });
    document.getElementById("root").appendChild(p.el);
    p.propose("The renewal has slipped to the 21st.", "The vendor confirmed the delay.");`,

  "a high-risk approval card": `
    import { approvalCard } from "${VIEW}";
    document.getElementById("root").appendChild(approvalCard({
      request: {
        id: "refund-8841",
        title: "Refund 1,240.00 USD",
        risk: "high",
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
      onDecide: () => {},
    }).el);`,

  "a task list, running, failed and cancellable": `
    import { taskList, signal } from "${VIEW}";
    const tasks = signal([
      { id: "t1", name: "Reindex", state: "running", percent: 60, steps: ["Read", "Write"] },
      { id: "t2", name: "Backfill", state: "failed", percent: 30, detail: "Upstream 503." },
      { id: "t3", name: "Verify", state: "done", percent: 100 },
    ]);
    document.getElementById("root").appendChild(
      taskList({ tasks, onCancel: () => {}, onRetry: () => {} }).el);`,

  "a line chart, with its cursor on a point": `
    import { lineChart } from "${VIEW}";
    const c = lineChart({
      rows: [
        { day: "Mon", errors: 143 }, { day: "Tue", errors: 92 },
        { day: "Wed", errors: 12 }, { day: "Thu", errors: 61 },
      ],
      x: "day", xLabel: "Day", title: "Errors this week",
      description: "Down since Monday.",
      series: [{ key: "errors", label: "Errors" }], locale: "en-US",
    });
    document.getElementById("root").appendChild(c.el);
    c.cursor.set(1);`,

  "a bar chart, an area chart and a scatter chart": `
    import { barChart, areaChart, scatterChart } from "${VIEW}";
    const root = document.getElementById("root");
    const rows = [
      { region: "North", change: 40, latency: 120, errors: 3 },
      { region: "South", change: -25, latency: 240, errors: 9 },
    ];
    root.appendChild(barChart({ rows, x: "region", title: "Change by region",
      series: [{ key: "change", label: "Change" }], locale: "en-US" }).el);
    root.appendChild(areaChart({ rows, x: "region", title: "Latency by region",
      series: [{ key: "latency", label: "Latency" }], locale: "en-US" }).el);
    root.appendChild(scatterChart({ rows, x: "latency", xValue: "latency",
      title: "Errors against latency",
      series: [{ key: "errors", label: "Errors" }], locale: "en-US" }).el);`,

  "a sparkline and a heatmap": `
    import { sparkline, heatmap, h } from "${VIEW}";
    const root = document.getElementById("root");
    const rows = [{ day: "Mon", errors: 143 }, { day: "Tue", errors: 7 }];
    root.appendChild(h("p", {}, "Errors ", sparkline({
      rows, key: "errors", label: "Errors this week", x: "day", locale: "en-US" }).el));
    root.appendChild(heatmap({
      rows: [{ service: "checkout", mon: 143, tue: 92 },
             { service: "billing", mon: 12, tue: 61 }],
      row: "service", title: "Errors by service",
      columns: [{ key: "mon", label: "Mon" }, { key: "tue", label: "Tue" }],
      locale: "en-US" }).el);`,

  "a dashboard shell with a board in it": `
    import { listTemplate, gridStack, h } from "${VIEW}";
    const root = document.getElementById("root");
    root.style.width = "900px";
    const board = gridStack({
      columns: 12, label: "Operations",
      panels: [
        { id: "deployments", title: "Deployments", x: 0, y: 0, w: 6, h: 1,
          load: () => h("p", { text: "Four services." }) },
        { id: "incidents", title: "Incidents", x: 6, y: 0, w: 6, h: 1,
          load: () => { throw new Error("Upstream 503."); } },
      ],
    });
    const shell = listTemplate({
      title: "Operations",
      sidebar: h("a", { href: "#deployments", text: "Deployments" }),
      sidebarLabel: "Boards",
      actions: [h("button", { type: "button", text: "Refresh all" })],
    }, board.el);
    root.appendChild(shell.el);`,

  "a stream with lines in it": `
    import { stream } from "${VIEW}";
    const s = stream({ announceEveryMs: 150, max: 20 });
    document.getElementById("root").appendChild(s.el);
    s.append("Reading the manifest");
    s.append("Two rows could not be read", "warn");
    s.append("Stopped", "error");`,
};

for (const engine of ENGINES) {
  for (const [what, source] of Object.entries(COMPONENTS)) {
    test(`[${engine}] axe is clean on ${what}`, async () => {
      const c = await mount(engine, source);
      try {
        const found = await violations(c);
        assert.equal(found.length, 0, `\n${reportable(found)}\n`);
      } finally { await c.close(); }
    });
  }
}
