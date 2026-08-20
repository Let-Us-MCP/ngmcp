/** The gallery: every component, reachable as a tool, gradeable by a person.
 *
 * The point is end-to-end evidence. A test suite says the components behave;
 * this says they arrived — through a real host, into a real frame, in front of
 * somebody who can see whether the bars point the right way. Each tool draws a
 * screen and tells the model exactly what should be visible, so the model can
 * walk a person through it and record what they actually saw.
 *
 * It is also the one place everything meets: a gateway over two upstream
 * servers, prompts, elicitation, sampling, a subscription stream, and the
 * legacy handshake a shipping host still opens with.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { App, compose, localUpstream, UserError } from "../../src/index.js";
import {
  contracts, type Deployment, type DayPoint, type Incident,
  type Check, type Graded, type Screen, type Verdict,
} from "./contract.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------- data */

const DEPLOYMENTS: Deployment[] = [
  { id: "d1", service: "checkout", env: "production", errors: 143, latency: 210 },
  { id: "d2", service: "billing", env: "production", errors: 12, latency: 180 },
  { id: "d3", service: "search", env: "staging", errors: 0, latency: 240 },
  { id: "d4", service: "notifications", env: "canary", errors: 7, latency: 150 },
  { id: "d5", service: "identity", env: "production", errors: 61, latency: 120 },
];

const WEEK: DayPoint[] = [
  { day: "Mon", errors: 143, latency: 210, deploys: 4 },
  { day: "Tue", errors: 92, latency: 180, deploys: 6 },
  { day: "Wed", errors: 12, latency: 240, deploys: 2 },
  { day: "Thu", errors: 61, latency: 150, deploys: 7 },
  { day: "Fri", errors: 7, latency: 120, deploys: 3 },
];

const INCIDENTS: Incident[] = [
  { id: "i1", title: "Payments timing out", service: "checkout", severity: "sev1", minutes: 42 },
  { id: "i2", title: "Search index stale", service: "search", severity: "sev3", minutes: 180 },
];

const BY_SERVICE = [
  { service: "checkout", mon: 143, tue: 92, wed: 12 },
  { service: "billing", mon: 12, tue: 30, wed: 8 },
  { service: "identity", mon: 61, tue: 44, wed: 21 },
];

/* ---------------------------------------------------------------- checks */

/* Written so each one can be answered by looking, without knowing anything
 * about how it was built. A check a person cannot decide is not a check. */
const CHECKS: Record<string, Check[]> = {
  charts: [
    { id: "charts.line", look: "A line chart titled Errors, with five marks, falling from left to right." },
    { id: "charts.keyboard", look: "Click the line chart and press the right arrow: a readout appears saying `Mon, Errors 143`, and a dashed vertical line marks the point." },
    { id: "charts.area", look: "An area chart whose fill reaches down to the axis, not floating." },
    { id: "charts.bars", look: "A bar chart where every bar stands on the bottom axis." },
    { id: "charts.scatter", look: "A scatter chart where the marks are spread by latency, not evenly spaced." },
    { id: "charts.sparkline", look: "Two small inline sparklines in a sentence, the second one orange." },
    { id: "charts.heatmap", look: "A heatmap where every cell shows its number as text as well as its shade." },
    { id: "charts.numbers", look: "Numbers over a thousand are grouped as 1,234,567 rather than 12,34,567." },
  ],
  table: [
    { id: "table.rows", look: "A table of deployments with four columns and a page of three rows." },
    { id: "table.filter", look: "Typing `bill` in the filter narrows it to one row and the status says `1 of 5`." },
    { id: "table.sort", look: "Clicking the Errors header sorts numerically: 143 above 61, not `12` above `7`." },
    { id: "table.keyboard", look: "Tab to a row and press Enter: it is selected and highlighted." },
    { id: "table.metrics", look: "Three metric tiles above it, one of them showing 1,234,567 with a green fall." },
  ],
  widgets: [
    { id: "widgets.granted", look: "The first button works and a toast says the host allowed it." },
    { id: "widgets.absent", look: "The second button offers `Copy instead` rather than doing nothing." },
    { id: "widgets.refused", look: "The third button says the host refused, in view, rather than failing silently." },
    { id: "widgets.prefill", look: "Pressing `Let the agent prefill it` fills two fields and marks them, and does NOT submit the form." },
    { id: "widgets.validate", look: "Submitting with the amount at 1240 shows `Over the limit.` under the field." },
  ],
  layout: [
    { id: "layout.columns", look: "Two columns, the left twice the width of the right." },
    { id: "layout.narrow", look: "Narrowing the window makes them one column." },
    { id: "layout.tabs", look: "Three tabs; left and right arrows move between them and only the selected one is in the tab order." },
    { id: "layout.dialog", look: "`Open the dialog` opens a modal that traps focus, and Escape closes it." },
    { id: "layout.toast", look: "`Raise a toast` shows a toast that dismisses itself." },
  ],
  agent: [
    { id: "agent.proposal", look: "Proposing shows the old text beside the new one and changes nothing until you accept." },
    { id: "agent.approval", look: "The approval card lists who asked, on whose behalf, which tool and which arguments." },
    { id: "agent.highrisk", look: "Approving requires typing the title back before the button enables." },
    { id: "agent.tasks", look: "Cancelling the running task leaves it at 60 percent, not zero, and says three of five steps happened." },
    { id: "agent.stream", look: "The log fills quickly and does not read every line aloud." },
  ],
  dashboard: [
    { id: "dash.panels", look: "Four panels: deployments, incidents, a chart, and one that failed." },
    { id: "dash.servers", look: "The deployments and incidents panels are labelled as coming from different servers." },
    { id: "dash.failed", look: "The failed panel says `Upstream 503.` and the other three still work." },
    { id: "dash.keyboard", look: "Tab to a panel and press the right arrow: it moves one column, and the footer records the new layout." },
    { id: "dash.narrow", look: "Narrowing the window puts the panels in one column; widening puts them back where they were." },
  ],
  surface: [
    { id: "surface.granted", look: "The list shows which capabilities this host actually granted." },
    { id: "surface.absent", look: "Pressing a button for a capability the host did not grant answers `absent`, and no call was made." },
    { id: "surface.refused", look: "A capability the host refuses answers `refused` with the host's reason, and is not silent." },
    { id: "surface.frame", look: "The frame facts list a display mode, a locale, and a safe-area inset." },
  ],
};

const screenOf = (name: string): Screen => ({ screen: name, checks: CHECKS[name] ?? [] });

/* --------------------------------------------------------------- grading */

/* Where a verdict goes. Not connection state: it is this application's own
 * store, written to disk, and every request that touches it names what it is
 * touching. Restarting the server mid-conversation loses nothing. */
const REPORT = process.env["NGMCP_GALLERY_REPORT"]
  ?? path.join(HERE, "report.json");

const allCheckIds = Object.values(CHECKS).flat().map((c) => c.id);

function readReport(): Graded[] {
  if (!existsSync(REPORT)) return [];
  try {
    return JSON.parse(readFileSync(REPORT, "utf8")) as Graded[];
  } catch {
    return [];
  }
}

function writeReport(all: Graded[]): void {
  mkdirSync(path.dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, `${JSON.stringify(all, null, 2)}\n`);
}

/* ------------------------------------------------- the servers behind it */

/* Two of them, so the dashboard is genuinely composed rather than pretending.
 * They are separate `App`s with no knowledge of each other, reached through a
 * gateway; over HTTP they would be separate processes and nothing here would
 * change. */
const deploysServer = new App({ name: "deploys", version: "1.0.0" });
deploysServer.tool("list", {
  description: "Deployments.", annotations: { readOnlyHint: true },
  summary: (out: { deployments: Deployment[] }) => `${out.deployments.length} deployments`,
}, async () => ({ deployments: DEPLOYMENTS }));

const incidentsServer = new App({ name: "incidents", version: "1.0.0" });
incidentsServer.tool("list", {
  description: "Open incidents.", annotations: { readOnlyHint: true },
  summary: (out: { incidents: Incident[] }) => `${out.incidents.length} incidents`,
}, async () => ({ incidents: INCIDENTS }));

const behind = compose({
  name: "operations",
  version: "1.0.0",
  upstreams: [
    { name: "deploys", transport: localUpstream(deploysServer) },
    { name: "incidents", transport: localUpstream(incidentsServer) },
    // Deliberately unreachable, so the dashboard shows what a composition does
    // when one of its members is down: names it, and carries on.
    {
      name: "billing",
      transport: { request: async () => { throw new Error("ECONNREFUSED"); } },
    },
  ],
});

const V = "2026-07-28";
const upstreamMeta = {
  "io.modelcontextprotocol/protocolVersion": V,
  "io.modelcontextprotocol/clientCapabilities": {},
};

async function throughGateway<T>(name: string): Promise<{ data: T; unreachable: Array<{ name: string; reason: string }> }> {
  const answer = await behind.handle({
    jsonrpc: "2.0", id: `gallery-${name}`, method: "tools/call",
    params: { name, arguments: {}, _meta: upstreamMeta },
  });
  const listed = await behind.handle({
    jsonrpc: "2.0", id: "gallery-list", method: "tools/list",
    params: { _meta: upstreamMeta },
  });
  const unreachable = (listed && "result" in listed
    ? (listed.result["_meta"] as { "ngmcp/unreachable"?: Array<{ name: string; reason: string }> })
      ?.["ngmcp/unreachable"] : undefined) ?? [];
  if (!answer || "error" in answer) {
    throw new UserError(`The ${name} server could not be reached.`);
  }
  return { data: answer.result["structuredContent"] as T, unreachable };
}

/* ------------------------------------------------------------ the gallery */

const app = new App({
  name: "ngmcp-gallery",
  version: "1.0.0",
  instructions:
    "A gallery of MCP App components. Call a show_ tool to draw a screen, then "
    + "read the checks in its summary out to the person, ask what they actually "
    + "saw, and record each answer with grade(check, verdict, note). Do not "
    + "grade anything yourself: you cannot see the view. Finish with report().",
});

/* One bundle, seven uris. The screen is injected as a global rather than
 * bundled seven times, so there is one build and no chance of six of them
 * drifting apart. */
const bundled = readFileSync(path.join(HERE, "view.html"), "utf8");
const SCREENS = ["charts", "table", "widgets", "layout", "agent", "dashboard", "surface"];
/* The dev host renders the first view registered, so whichever screen is being
 * looked at goes first. A real host picks by uri and does not care. */
const first = process.env["NGMCP_SCREEN"];
const order = first && SCREENS.includes(first)
  ? [first, ...SCREENS.filter((s) => s !== first)]
  : SCREENS;
for (const screen of order) {
  app.view(`ui://gallery/${screen}`, {
    html: bundled.replace(
      '<div id="root"></div>',
      `<script>window.__NGMCP_SCREEN=${JSON.stringify(screen)};`
      + `window.__NGMCP_CAPS={openLink:{},sendMessage:{}};</script>`
      + '<div id="root"></div>'),
  });
}

app.implement(contracts, {
  show_charts: async () => ({
    ...screenOf("charts"), points: WEEK, services: BY_SERVICE,
  }),
  show_table: async () => ({
    ...screenOf("table"), deployments: DEPLOYMENTS, trend: WEEK,
  }),
  show_widgets: async () => ({
    ...screenOf("widgets"), capabilities: ["downloadFile"],
  }),
  show_layout: async () => screenOf("layout"),
  show_agent: async () => ({
    ...screenOf("agent"),
    proposal: {
      current: "The renewal is on track for the 14th.",
      next: "The renewal has slipped to the 21st.",
      why: "The vendor confirmed the delay this morning.",
    },
  }),
  show_dashboard: async () => {
    const deployments = await throughGateway<{ deployments: Deployment[] }>("deploys.list");
    const incidents = await throughGateway<{ incidents: Incident[] }>("incidents.list");
    return {
      ...screenOf("dashboard"),
      deployments: deployments.data.deployments,
      incidents: incidents.data.incidents,
      composedOf: ["deploys", "incidents"],
      unreachable: deployments.unreachable,
    };
  },
  show_surface: async (_input, ctx) => ({
    ...screenOf("surface"),
    capabilities: Object.keys(ctx.capabilities),
    context: { locale: "en-US", displayMode: "inline" },
  }),

  list_checks: async () => {
    const screens = SCREENS.map(screenOf);
    return { screens, total: screens.reduce((n, s) => n + s.checks.length, 0) };
  },

  grade: async ({ check, verdict, note }) => {
    if (!allCheckIds.includes(check)) {
      throw new UserError(
        `No check called ${check}. Call list_checks to see the ids.`);
    }
    const all = readReport().filter((g) => g.check !== check);
    const recorded: Graded = {
      check,
      verdict: verdict as Verdict,
      note: note ?? "",
      at: new Date().toISOString(),
    };
    all.push(recorded);
    writeReport(all);
    return {
      recorded,
      graded: all.length,
      remaining: allCheckIds.length - all.length,
    };
  },

  report: async () => {
    const graded = readReport();
    const seen = new Set(graded.map((g) => g.check));
    return {
      graded,
      passed: graded.filter((g) => g.verdict === "pass").length,
      failed: graded.filter((g) => g.verdict === "fail").length,
      unsure: graded.filter((g) => g.verdict === "unsure").length,
      remaining: allCheckIds.filter((id) => !seen.has(id)),
    };
  },
});

/* The three server-to-client questions, so a host can be checked on those too
 * rather than only on what it draws. */

app.tool("confirm_destructive", {
  description:
    "Ask the person to confirm something destructive, through the host's own "
    + "dialog. Checks whether this host supports elicitation at all.",
  annotations: { destructiveHint: true },
}, async (_input, ctx) => {
  const answer = await ctx.elicit({
    message: "This would restart checkout in production. Why?",
    requestedSchema: {
      type: "object",
      properties: { reason: { type: "string", description: "One line." } },
      required: ["reason"],
    },
  });
  if (answer.action === "unavailable") {
    return { outcome: "unavailable", detail: answer.reason,
      meaning: "This host offers no elicitation. That is a host fact, not a failure here." };
  }
  if (answer.action !== "accept") {
    return { outcome: answer.action,
      meaning: "The person did not agree, so nothing was done." };
  }
  return { outcome: "accept", reason: String(answer.content["reason"] ?? ""),
    meaning: "The host asked, the person answered, and the answer came back." };
});

app.tool("ask_the_model", {
  description:
    "Ask the host's own model to summarise the incidents. Checks whether this "
    + "host supports sampling.",
  annotations: { readOnlyHint: true },
}, async (_input, ctx) => {
  const answer = await ctx.sample({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Summarise these incidents in one sentence: ${JSON.stringify(INCIDENTS)}`,
      },
    }],
    maxTokens: 200,
  });
  if (!answer.ok) {
    return { outcome: answer.reason, detail: answer.detail,
      meaning: answer.reason === "absent"
        ? "This host offers no sampling. A host fact, not a failure here."
        : "The host was asked and said no." };
  }
  return { outcome: "ok", model: answer.model, text: answer.content.text ?? "" };
});

app.tool("stir", {
  description:
    "Change a resource, so anything holding a subscriptions/listen stream is "
    + "told. Checks whether a panel can update without a conversation turn.",
}, async () => {
  const told = app.resourceUpdated("ui://gallery/dashboard");
  return {
    told,
    meaning: told === 0
      ? "Nothing was listening. This host does not open a subscription stream."
      : `${told} open subscription was told.`,
  };
});

app.prompt("walk_the_gallery", {
  description: "Walk a person through every screen and record what they saw.",
  arguments: [
    { name: "screen", description: "Start at one screen, or leave blank for all.", required: false },
  ],
}, (args) => [{
  role: "user",
  content: {
    type: "text",
    text: [
      args["screen"]
        ? `Show me the ${args["screen"]} screen from the gallery.`
        : "Walk me through the whole gallery, one screen at a time.",
      "",
      "For each screen: call its show_ tool, then read me the checks one at a",
      "time and wait for me to say what I actually saw. Record each answer with",
      "grade(check, verdict, note) as I give it — pass, fail or unsure — and put",
      "what I said in the note. Do not guess a verdict: you cannot see the view.",
      "When we are done, call report() and tell me what failed.",
    ].join("\n"),
  },
}]);

/* Three ways to run, and which one you want depends on what you are checking.
 *
 * - By default: stdio with the legacy shim in front, because a shipping host
 *   still opens with `initialize`. The shim holds nothing; see
 *   `src/transport/legacy.ts` for what that costs.
 * - `NGMCP_STRICT=1`: no shim. Every request carries its own `_meta`, which is
 *   what `2026-07-28` actually asks for.
 * - `NGMCP_DEV_HOST=1`: a browser instead of a host, so a component that draws
 *   wrongly can be told apart from a host that did not draw it.
 */
if (process.env["NGMCP_DEV_HOST"] === "1") {
  const { devHost } = await import("../../src/dev/host.js");
  const screen = process.env["NGMCP_SCREEN"] ?? "charts";
  const { url } = await devHost(app, { port: Number(process.env["PORT"] ?? 0) });
  process.stderr.write(
    `The gallery is at ${url}\n`
    + `It opens on the ${screen} screen. Change NGMCP_SCREEN to see another: `
    + `${SCREENS.join(", ")}.\n`);
} else {
  app.serve({
    legacy: process.env["NGMCP_STRICT"] === "1" ? false : { clientName: "legacy-host" },
  });
}
