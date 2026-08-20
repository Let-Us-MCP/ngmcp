/** The gallery's declaration: every component, reachable as a tool.
 *
 * One tool per screen. Each returns two things that are deliberately not the
 * same thing: `structuredContent`, which the view draws, and a summary, which
 * is all the model is told. The summary here does a second job — it says what
 * a person should be able to see if the screen rendered correctly, so the
 * conversation itself becomes the test.
 */
import { defineTools, type } from "../../src/index.js";

export interface Deployment {
  id: string;
  service: string;
  env: "production" | "staging" | "canary";
  errors: number;
  latency: number;
}

export interface DayPoint {
  day: string;
  errors: number;
  latency: number;
  deploys: number;
}

export interface Incident {
  id: string;
  title: string;
  service: string;
  severity: "sev1" | "sev2" | "sev3";
  minutes: number;
}

/** What a person is asked to confirm about one screen. */
export interface Check {
  id: string;
  /** Written so it can be answered yes or no by looking. */
  look: string;
}

export interface Screen {
  screen: string;
  checks: Check[];
}

export type Verdict = "pass" | "fail" | "unsure";

export interface Graded {
  check: string;
  verdict: Verdict;
  note: string;
  at: string;
}

const screen = <T>(description: string, view: string, jsonSchema?: object) => ({
  description,
  annotations: { readOnlyHint: true },
  view,
  visibility: ["model", "app"] as const,
  output: type<T>(jsonSchema),
});

export const contracts = defineTools({
  show_charts: {
    ...screen<Screen & { points: DayPoint[]; services: Array<{ service: string; mon: number; tue: number; wed: number }> }>(
      "Draw the six charts: line, area, bar, scatter, sparkline and heatmap. "
      + "Use when asked to see charts or to check charting works.",
      "ui://gallery/charts"),
    summary: (out: Screen) => describe(out),
  },

  show_table: {
    ...screen<Screen & { deployments: Deployment[]; trend: DayPoint[] }>(
      "Draw a data table with sorting, filtering, paging and selection, with "
      + "metrics and a sparkline beside it.",
      "ui://gallery/table"),
    summary: (out: Screen) => describe(out),
  },

  show_widgets: {
    ...screen<Screen & { capabilities: string[] }>(
      "Draw the input widgets: a button in each of its three host states, and "
      + "a form an agent has prefilled without submitting.",
      "ui://gallery/widgets"),
    summary: (out: Screen) => describe(out),
  },

  show_layout: {
    ...screen<Screen>(
      "Draw the layouts: stack, row, columns, card, tabs and a modal dialog, "
      + "with a toast and a banner.",
      "ui://gallery/layout"),
    summary: (out: Screen) => describe(out),
  },

  show_agent: {
    ...screen<Screen & { proposal: { current: string; next: string; why: string } }>(
      "Draw the agent components: a proposal, a high-risk approval card with "
      + "its provenance, a task list, and a streaming log.",
      "ui://gallery/agent"),
    summary: (out: Screen) => describe(out),
  },

  show_dashboard: {
    ...screen<Screen & {
      deployments: Deployment[];
      incidents: Incident[];
      composedOf: string[];
      unreachable: Array<{ name: string; reason: string }>;
    }>(
      "Draw the dashboard shell: a board of panels, each loading from a "
      + "different server behind one gateway, movable from the keyboard.",
      "ui://gallery/dashboard"),
    summary: (out: Screen & { composedOf: string[] }) =>
      `${describe(out)} The panels come from ${out.composedOf.length} servers `
      + `behind one gateway: ${out.composedOf.join(", ")}.`,
  },

  show_surface: {
    ...screen<Screen & { capabilities: string[]; context: Record<string, unknown> }>(
      "Draw the host surface: what this host granted, what it withheld, and "
      + "what happens when it refuses.",
      "ui://gallery/surface"),
    summary: (out: Screen) => describe(out),
  },

  list_checks: {
    description:
      "List every check in the gallery, so they can be walked through in order.",
    annotations: { readOnlyHint: true },
    output: type<{ screens: Screen[]; total: number }>(),
    summary: (out: { screens: Screen[]; total: number }) =>
      `${out.total} checks across ${out.screens.length} screens: `
      + out.screens.map((s) => s.screen).join(", "),
  },

  grade: {
    description:
      "Record whether a check passed, once a person has actually looked. "
      + "Pass the check id from the screen's summary or from list_checks.",
    input: type<{ check: string; verdict: Verdict; note?: string }>({
      type: "object",
      properties: {
        check: { type: "string", description: "The check id, such as charts.bars." },
        verdict: { type: "string", enum: ["pass", "fail", "unsure"] },
        note: { type: "string", description: "What was actually seen." },
      },
      required: ["check", "verdict"],
    }),
    output: type<{ recorded: Graded; graded: number; remaining: number }>(),
    summary: (out: { recorded: Graded; remaining: number }) =>
      `Recorded ${out.recorded.check} as ${out.recorded.verdict}. `
      + `${out.remaining} checks still unanswered.`,
  },

  report: {
    description:
      "What has been graded so far, and what is left. Read this before saying "
      + "the gallery works.",
    annotations: { readOnlyHint: true },
    output: type<{
      graded: Graded[];
      passed: number;
      failed: number;
      unsure: number;
      remaining: string[];
    }>(),
    summary: (out: { passed: number; failed: number; unsure: number; remaining: string[] }) =>
      `${out.passed} passed, ${out.failed} failed, ${out.unsure} unsure, `
      + `${out.remaining.length} not looked at`
      + (out.failed ? ". Something is broken; the notes say what." : "."),
  },
});

/** The screen's checks, written into the sentence the model is given.
 *
 * The model cannot see the view, so the only way it can help a person check
 * one is by being told what is supposed to be there. */
function describe(out: Screen): string {
  const lines = out.checks.map((c) => `- ${c.id}: ${c.look}`);
  return `Showing ${out.screen}. Ask the person to confirm each of these, then `
    + `record each one with grade(check, verdict):\n${lines.join("\n")}`;
}
