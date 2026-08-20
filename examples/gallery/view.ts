/** The gallery's view: one bundle, seven screens.
 *
 * Which screen this is comes from `window.__NGMCP_SCREEN`, injected by the
 * server when it registers the `ui://` uri. One bundle rather than seven means
 * one build, one set of styles, and no chance of six of them drifting.
 *
 * Every screen fetches its own data through the typed client, so it works in
 * any host that proxies a tool call, including the dev host here and a real
 * one that has never heard of this example.
 */
import type { contracts, Deployment, DayPoint, Incident, Check } from "./contract.js";
import {
  client, hostBridge, surface, signal, computed, h,
  dataTable, metric, lineChart, areaChart, barChart, scatterChart, sparkline, heatmap,
  button, form, toaster, banner,
  stack, row, spacer, divider, columns, card, tabs, dialog,
  proposal, approvalCard, taskList, stream,
  listTemplate, gridStack,
} from "../../src/view/index.js";

const bridge = hostBridge();
const api = client<typeof contracts>({ bridge });

/* Everything the host granted, and everything it did not. The gallery is
 * partly a test of the host, so it says which is which rather than assuming. */
const host = surface({
  bridge,
  capabilities: (window as unknown as { __NGMCP_CAPS?: Record<string, unknown> })
    .__NGMCP_CAPS ?? {},
  context: { locale: "en-US" },
  reportSize: false,
});

const screen = (window as unknown as { __NGMCP_SCREEN?: string }).__NGMCP_SCREEN ?? "charts";
const root = document.getElementById("root")!;
const notes = toaster({ timeoutMs: 4000 });

/** The checklist, drawn beside the thing being checked.
 *
 * A person grading a screen should not have to keep the list in their head or
 * scroll to a different window for it. */
const checklist = (checks: readonly Check[]) =>
  card({ title: "What you should see", label: "Checklist" },
    h("ol", { class: "checks" },
      ...checks.map((check) => h("li", { class: "check" },
        h("code", { class: "check-id", text: check.id }),
        h("span", { class: "check-look", text: ` ${check.look}` })))),
    h("p", { class: "check-hint" },
      "Tell Claude which of these you saw. It will record each one with ",
      h("code", { text: "grade" }), "."));

const ready = () => { document.documentElement.dataset.ready = "1"; };

const failed = (error: unknown) => {
  root.append(banner({
    text: `This screen could not load: ${error instanceof Error ? error.message : String(error)}`,
    tone: "error",
  }).el);
  ready();
};

/* ------------------------------------------------------------------ charts */

async function charts() {
  const data = await api.show_charts({});
  const points = signal<readonly DayPoint[]>(data.points);

  root.append(stack({ gap: "loose" },
    checklist(data.checks),
    columns({ weights: [1, 1] },
      card({ title: "Errors over the week" },
        lineChart({
          rows: points, x: "day", xLabel: "Day", title: "Errors",
          description: "One line, one mark per day, and a cursor you can walk.",
          series: [{ key: "errors", label: "Errors" }],
          locale: host.locale,
        }).el),
      card({ title: "Latency, as a volume" },
        areaChart({
          rows: points, x: "day", title: "Latency",
          series: [{ key: "latency", label: "Latency, ms" }],
          locale: host.locale,
        }).el)),
    columns({ weights: [1, 1] },
      card({ title: "Deploys a day" },
        barChart({
          rows: points, x: "day", title: "Deploys",
          series: [{ key: "deploys", label: "Deploys" }],
          locale: host.locale,
        }).el),
      card({ title: "Errors against latency" },
        scatterChart({
          rows: points, x: "latency", xValue: "latency", title: "Errors against latency",
          series: [{ key: "errors", label: "Errors" }],
          locale: host.locale,
        }).el)),
    card({ title: "The same week, in a word" },
      h("p", {},
        "Errors this week ",
        sparkline({
          rows: points, key: "errors", label: "Errors this week", x: "day",
          locale: host.locale,
        }).el,
        " and latency ",
        sparkline({
          rows: points, key: "latency", label: "Latency this week", x: "day",
          color: "#ff9f0a", locale: host.locale,
        }).el)),
    card({ title: "Errors by service" },
      heatmap({
        rows: data.services, row: "service", title: "Errors by service and day",
        columns: [
          { key: "mon", label: "Mon" }, { key: "tue", label: "Tue" },
          { key: "wed", label: "Wed" },
        ],
        locale: host.locale,
      }).el)));
  ready();
}

/* ------------------------------------------------------------------- table */

async function table() {
  const data = await api.show_table({});
  const rows = signal<readonly Deployment[]>(data.deployments);
  const failing = () => rows().filter((d) => d.errors > 0).length;

  const grid = dataTable<Deployment>({
    rows,
    columns: [
      { key: "service", label: "Service" },
      { key: "env", label: "Environment" },
      { key: "errors", label: "Errors", align: "end" },
      { key: "latency", label: "Latency, ms", align: "end" },
    ],
    selection: "single",
    pageSize: 3,
    filterLabel: "Filter deployments",
  });

  root.append(stack({ gap: "loose" },
    checklist(data.checks),
    columns({ weights: [1, 1, 1] },
      card({ title: "Deployments" },
        metric({ label: "Total", value: () => rows().length, locale: host.locale }).el),
      card({ title: "Failing" },
        metric({
          label: "With errors", value: failing,
          state: () => (failing() > 0 ? "bad" : "ok"), locale: host.locale,
        }).el),
      card({ title: "Requests" },
        metric({
          label: "This week", value: 1234567, delta: -1200, deltaIsGood: "down",
          locale: host.locale,
        }).el)),
    card({ title: "All deployments" }, grid.el),
    card({ title: "The week" },
      h("p", {}, "Errors ",
        sparkline({
          rows: data.trend, key: "errors", label: "Errors this week", x: "day",
          locale: host.locale,
        }).el))));
  ready();
}

/* ----------------------------------------------------------------- widgets */

async function widgets() {
  const data = await api.show_widgets({});
  const granted = Object.fromEntries(data.capabilities.map((c) => [c, {}]));

  const refunds = form({
    fields: [
      { name: "invoice", label: "Invoice", required: true, help: "As printed." },
      { name: "amount", label: "Amount", type: "number", required: true,
        validate: (v) => (Number(v) > 1000 ? "Over the limit." : undefined) },
      { name: "reason", label: "Reason", type: "textarea" },
    ],
    submitLabel: "Refund",
    onSubmit: (values) => {
      notes.show(`Would refund ${String(values["invoice"] ?? "")}.`, "success");
    },
  });

  root.append(stack({ gap: "loose" },
    checklist(data.checks),
    card({ title: "A button, in each of the three host states" },
      stack({ gap: "normal" },
        button({
          label: "Export, granted", requires: "downloadFile", capabilities: granted,
          onActivate: () => notes.show("The host allowed it.", "success"),
        }).el,
        button({
          label: "Export, absent", requires: "downloadFile", capabilities: {},
          fallback: {
            label: "Copy instead",
            onActivate: () => notes.show("Copied to the clipboard instead.", "info"),
          },
          onActivate: () => notes.show("Never reached.", "info"),
        }).el,
        button({
          label: "Export, refused", requires: "downloadFile", capabilities: granted,
          onActivate: () => { throw new Error("The host refused that."); },
        }).el)),
    card({ title: "A form an agent filled in" },
      stack({ gap: "normal" },
        button({
          label: "Let the agent prefill it",
          onActivate: () => refunds.prefill(
            { invoice: "2026-0814", amount: "1240" }, "the agent"),
        }).el,
        refunds.el)),
    notes.el));
  ready();
}

/* ------------------------------------------------------------------ layout */

async function layout() {
  const data = await api.show_layout({});
  const confirm = dialog({
    title: "Delete four files?",
    content: h("p", { text: "This cannot be undone." }),
    actions: [
      h("button", { type: "button", class: "btn", text: "Cancel",
        onclick: () => confirm.close("action") }),
      h("button", { type: "button", class: "btn btn-primary", text: "Delete",
        onclick: () => { confirm.close("action"); notes.show("Deleted.", "success"); } }),
    ],
    onClose: () => {},
  });

  root.append(stack({ gap: "loose" },
    checklist(data.checks),
    banner({ text: "This is a banner: a condition, not an event.", tone: "warning" }).el,
    columns({ weights: [2, 1] },
      card({ title: "Columns, two to one" },
        h("p", { text: "Narrow the window and these become one column." })),
      card({ title: "The other one" }, h("p", { text: "Still here." }))),
    card({ title: "Tabs" },
      tabs({
        label: "Sections",
        tabs: [
          { id: "one", label: "Summary", content: () => h("p", { text: "The first panel." }) },
          { id: "two", label: "History", content: () => h("p", { text: "The second panel." }) },
          { id: "three", label: "Settings", content: () => h("p", { text: "The third panel." }) },
        ],
      }).el),
    card({ title: "A row, with a spacer" },
      stack({ gap: "normal" },
        row({ gap: "normal" },
          h("span", { text: "left" }), spacer(), h("span", { text: "right" })),
        divider("and then"),
        row({ gap: "normal" },
          button({ label: "Open the dialog", onActivate: () => confirm.open() }).el,
          button({
            label: "Raise a toast",
            onActivate: () => notes.show("A toast. Several become one announcement.", "info"),
          }).el))),
    confirm.el,
    notes.el));
  ready();
}

/* ------------------------------------------------------------------- agent */

async function agent() {
  const data = await api.show_agent({});
  const current = signal(data.proposal.current);

  const change = proposal({
    current,
    render: (value) => value,
    onAccept: (value) => { current.set(value); notes.show("Applied.", "success"); },
    onReject: () => notes.show("Left alone.", "info"),
  });

  const approval = approvalCard({
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
    onDecide: (decision) =>
      notes.show(`Recorded: ${decision.decision}.`, "success"),
  });

  const tasks = signal([
    { id: "t1", name: "Reindex", state: "running" as const, percent: 60,
      steps: ["Read the manifest", "Write the index"] },
    { id: "t2", name: "Backfill", state: "failed" as const, percent: 30,
      detail: "Upstream 503." },
    { id: "t3", name: "Verify", state: "done" as const, percent: 100 },
  ]);
  const list = taskList({
    tasks,
    onCancel: (task) => {
      tasks.update((all) => all.map((t) => (t.id === task.id
        ? { ...t, state: "cancelled" as const,
            detail: "Stopped after 3 of 5 steps. Completed steps were not rolled back." }
        : t)));
    },
    onRetry: () => notes.show("Retrying.", "info"),
  });

  const log = stream({ announceEveryMs: 2000, max: 200, label: "Reindex log" });
  let line = 0;
  const timer = setInterval(() => {
    line += 1;
    if (line > 40) { clearInterval(timer); return; }
    log.append(`[${String(line).padStart(3, "0")}] indexed batch ${line}`,
      line % 13 === 0 ? "warn" : "info");
  }, 250);

  root.append(stack({ gap: "loose" },
    checklist(data.checks),
    card({ title: "A proposal: the agent proposes, you decide" },
      stack({ gap: "normal" },
        h("p", { class: "current-text", text: current }),
        button({
          label: "Have the agent propose a change",
          onActivate: () => change.propose(data.proposal.next, data.proposal.why),
        }).el,
        change.el)),
    card({ title: "An approval, with its provenance" }, approval.el),
    card({ title: "Tasks that do not lie about progress" }, list.el),
    card({ title: "A log that does not shout" }, log.el),
    notes.el));
  ready();
}

/* --------------------------------------------------------------- dashboard */

async function dashboard() {
  const data = await api.show_dashboard({});
  const saved = signal<string>("nothing saved yet");

  const board = gridStack({
    columns: 12,
    label: "Operations",
    onLayoutChange: (next) => {
      // The protocol has no sessions, so a layout is a value that goes to a
      // tool as an ordinary argument and comes back as a handle.
      saved.set(`${next.panels.length} panels, `
        + next.panels.map((p) => `${p.id} at ${p.x},${p.y}`).join("; "));
    },
    panels: [
      {
        id: "deployments", title: "Deployments (deploys server)", x: 0, y: 0, w: 7, h: 1,
        load: () => dataTable<Deployment>({
          rows: data.deployments,
          columns: [
            { key: "service", label: "Service" },
            { key: "env", label: "Environment" },
            { key: "errors", label: "Errors", align: "end" },
          ],
          selection: "none",
          filterable: false,
        }).el,
      },
      {
        id: "incidents", title: "Incidents (incidents server)", x: 7, y: 0, w: 5, h: 1,
        load: () => dataTable<Incident>({
          rows: data.incidents,
          columns: [
            { key: "title", label: "Incident" },
            { key: "severity", label: "Severity" },
            { key: "minutes", label: "Minutes", align: "end" },
          ],
          selection: "none",
          filterable: false,
        }).el,
      },
      {
        id: "errors", title: "Errors this week", x: 0, y: 1, w: 7, h: 1,
        load: () => lineChart({
          rows: data.deployments.map((d, i) => ({ day: d.service, errors: d.errors, i })),
          x: "day", title: "Errors by service",
          series: [{ key: "errors", label: "Errors" }],
          locale: host.locale, height: 180,
        }).el,
      },
      {
        id: "broken", title: "A panel whose tool failed", x: 7, y: 1, w: 5, h: 1,
        load: () => { throw new Error("Upstream 503."); },
      },
    ],
  });

  const shell = listTemplate({
    title: "Operations",
    sidebarLabel: "Servers",
    sidebar: stack({ gap: "tight" },
      ...data.composedOf.map((name) => h("p", { class: "server", text: name })),
      ...data.unreachable.map((u) =>
        h("p", { class: "server server-down", text: `${u.name}: ${u.reason}` }))),
    actions: [
      button({ label: "Refresh all", onActivate: () => board.refreshAll() }).el,
    ],
    footer: h("small", { class: "layout-state", text: computed(() => `Layout: ${saved()}`) }),
  }, board.el);

  root.append(stack({ gap: "loose" }, checklist(data.checks), shell.el));
  ready();
}

/* ----------------------------------------------------------------- surface */

async function surface_() {
  const data = await api.show_surface({});
  const outcomes = signal<readonly string[]>([]);
  const record = (what: string, outcome: string) =>
    outcomes.update((all) => [...all, `${what}: ${outcome}`]);

  root.append(stack({ gap: "loose" },
    checklist(data.checks),
    card({ title: "What this host granted" },
      data.capabilities.length
        ? h("ul", { class: "caps" },
            ...data.capabilities.map((c) => h("li", { text: c })))
        : h("p", { text: "Nothing. Which is a real thing a host does." })),
    card({ title: "Ask it for something" },
      stack({ gap: "normal" },
        button({
          label: "Open a link",
          onActivate: async () => record("openLink", await host.openLink("https://modelcontextprotocol.io")),
        }).el,
        button({
          label: "Ask for fullscreen",
          onActivate: async () => record("requestDisplayMode",
            await host.requestDisplayMode("fullscreen")),
        }).el,
        button({
          label: "Send a message to the conversation",
          onActivate: async () => record("sendMessage",
            await host.sendMessage("The gallery says hello.")),
        }).el,
        )),
    card({ title: "What came back" },
      h("pre", { class: "outcome-log", text: computed(() =>
        (outcomes().length ? outcomes().join("\n") : "Nothing asked yet.")) })),
    card({ title: "The frame" },
      h("dl", { class: "surface-facts" },
        h("dt", { text: "Display mode" }), h("dd", { text: host.displayMode }),
        h("dt", { text: "Locale" }),
        h("dd", { text: computed(() => host.locale() ?? "not said") }),
        h("dt", { text: "Safe area, top" }),
        h("dd", { text: computed(() => `${host.safeArea().top}px`) })))));
  ready();
}

const SCREENS: Record<string, () => Promise<void>> = {
  charts, table, widgets, layout, agent, dashboard, surface: surface_,
};

try {
  await (SCREENS[screen] ?? charts)();
} catch (error) {
  failed(error);
}
