/** The Titanic, declared once.
 *
 * The example exists to make one point concrete: a tool answers twice, and the
 * two halves are for different readers. `structuredContent` is the data, drawn
 * as a chart by a host with a frame. `content` is what the model — and any
 * host without a frame, which today includes every terminal client — actually
 * receives, and writing a sentence there throws the answer away.
 *
 * So the summaries here return **drawings in text**: bars, a histogram, a
 * table, a mermaid block. The same numbers, twice, for two kinds of reader.
 */
import { defineTools, type } from "../../src/index.js";

export interface Passenger {
  id: number;
  name: string;
  survived: boolean;
  klass: 1 | 2 | 3;
  sex: "male" | "female";
  age: number | null;
  fare: number;
  embarked: string;
  relatives: number;
}

export interface Band {
  band: string;
  total: number;
  survived: number;
  rate: number;
}

export const contracts = defineTools({
  survival_by: {
    description:
      "Survival rates on the Titanic, grouped by class, sex, age band, port of "
      + "embarkation or number of relatives aboard. Answers with a bar chart "
      + "drawn in text as well as the numbers.",
    annotations: { readOnlyHint: true },
    view: "ui://titanic/survival",
    visibility: ["model", "app"],
    input: type<{ by?: "class" | "sex" | "age" | "port" | "relatives" }>({
      type: "object",
      properties: {
        by: {
          type: "string",
          enum: ["class", "sex", "age", "port", "relatives"],
          description: "What to group by. Defaults to class.",
        },
      },
    }),
    output: type<{ by: string; bands: Band[]; overall: Band; chart: string }>(),
    // The chart is built by the server and handed over as the sentence. A host
    // with a frame draws its own from `bands`; one without gets this, which is
    // the same information rather than a description of it.
    summary: (out: { by: string; bands: Band[]; overall: Band; chart: string }) =>
      out.chart,
  },

  age_distribution: {
    description:
      "How old the passengers were, as a histogram in text, optionally split "
      + "by whether they survived.",
    annotations: { readOnlyHint: true },
    view: "ui://titanic/ages",
    visibility: ["model", "app"],
    input: type<{ survived?: boolean; buckets?: number }>({
      type: "object",
      properties: {
        survived: { type: "boolean", description: "Only survivors, or only those lost." },
        buckets: { type: "number", description: "How many bars. Ten by default." },
      },
    }),
    output: type<{
      ages: number[]; counted: number; unknown: number;
      median: number; chart: string;
    }>(),
    summary: (out: { chart: string; unknown: number; counted: number }) =>
      `${out.chart}\n\n${out.counted} passengers with a recorded age; `
      + `${out.unknown} without one, which are not in the chart.`,
  },

  passengers: {
    description:
      "Individual passengers, filtered and sorted. Answers with a markdown "
      + "table as well as the rows.",
    annotations: { readOnlyHint: true },
    view: "ui://titanic/passengers",
    visibility: ["model", "app"],
    input: type<{
      klass?: 1 | 2 | 3; sex?: "male" | "female"; survived?: boolean;
      sort?: "fare" | "age" | "name"; limit?: number;
    }>({
      type: "object",
      properties: {
        klass: { type: "number", enum: [1, 2, 3] },
        sex: { type: "string", enum: ["male", "female"] },
        survived: { type: "boolean" },
        sort: { type: "string", enum: ["fare", "age", "name"] },
        limit: { type: "number", description: "Rows to return. Twenty by default." },
      },
    }),
    output: type<{
      passengers: Passenger[]; matched: number; shown: number; table: string;
    }>(),
    summary: (out: { table: string; matched: number; shown: number }) =>
      `${out.shown} of ${out.matched} matching passengers:\n\n${out.table}`,
  },

  who_survived: {
    description:
      "A diagram of who lived and who did not, as a mermaid flowchart. Use "
      + "when the shape of the outcome matters more than the exact numbers.",
    annotations: { readOnlyHint: true },
    output: type<{ diagram: string; counts: Record<string, number> }>(),
    summary: (out: { diagram: string }) => out.diagram,
  },
});
