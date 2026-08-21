/** The Titanic, served two ways at once.
 *
 * 891 real rows, read from the CSV beside this file. Four tools, each of which
 * answers with the data for a host that has a frame and a drawing in text for
 * one that does not. In Claude Code there is no frame, so the text is not a
 * consolation prize: it is the entire rendering, and a bar chart in monospace
 * carries the numbers where a sentence would have thrown them away.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  App, UserError, bars, histogram, table, mermaid, section,
} from "../../src/index.js";
import { contracts, type Band, type Passenger } from "./contract.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* A CSV parser rather than a dependency, because the runtime here has none and
 * this file is the only thing that needs one. Quoted fields matter: half the
 * names in this dataset contain a comma. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = []; field = "";
      continue;
    }
    field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f !== ""));
}

/* The bundle lands in `dist/` and the data stays beside the source, so both
 * are worth looking in: this file runs from either depending on how it was
 * started, and a missing dataset should say which paths were tried rather than
 * failing with a bare ENOENT. */
const readDataset = (): string => {
  const tried = [
    path.join(HERE, "titanic.csv"),
    path.join(HERE, "..", "titanic.csv"),
  ];
  for (const where of tried) {
    try { return readFileSync(where, "utf8"); } catch { /* try the next */ }
  }
  throw new Error(`titanic.csv not found. Looked in:\n  ${tried.join("\n  ")}`);
};

const [header, ...lines] = parseCsv(readDataset());
const at = (row: string[], name: string): string =>
  row[(header ?? []).indexOf(name)] ?? "";

const PASSENGERS: Passenger[] = lines.map((row) => ({
  id: Number(at(row, "PassengerId")),
  name: at(row, "Name"),
  survived: at(row, "Survived") === "1",
  klass: Number(at(row, "Pclass")) as 1 | 2 | 3,
  sex: at(row, "Sex") === "female" ? "female" : "male",
  // Missing is null rather than zero. A newborn and an unrecorded age are not
  // the same thing, and averaging them together is how the second becomes the
  // first in every summary downstream.
  age: at(row, "Age") === "" ? null : Number(at(row, "Age")),
  fare: Number(at(row, "Fare") || 0),
  embarked: at(row, "Embarked"),
  relatives: Number(at(row, "SibSp") || 0) + Number(at(row, "Parch") || 0),
}));

const rate = (group: readonly Passenger[]): Band => {
  const survived = group.filter((p) => p.survived).length;
  return {
    band: "",
    total: group.length,
    survived,
    rate: group.length ? Math.round((survived / group.length) * 10000) / 100 : 0,
  };
};

const banded = (
  groups: ReadonlyArray<[string, readonly Passenger[]]>,
): Band[] => groups
  .filter(([, group]) => group.length > 0)
  .map(([band, group]) => ({ ...rate(group), band }));

const PORTS: Record<string, string> = {
  S: "Southampton", C: "Cherbourg", Q: "Queenstown", "": "Unrecorded",
};

const ageBand = (age: number | null): string => {
  if (age === null) return "Unrecorded";
  if (age < 13) return "Child, under 13";
  if (age < 20) return "13 to 19";
  if (age < 40) return "20 to 39";
  if (age < 60) return "40 to 59";
  return "60 and over";
};

const GROUPS: Record<string, () => Band[]> = {
  class: () => banded(([1, 2, 3] as const).map((k) =>
    [`${k === 1 ? "First" : k === 2 ? "Second" : "Third"} class`,
      PASSENGERS.filter((p) => p.klass === k)])),
  sex: () => banded((["female", "male"] as const).map((s) =>
    [s === "female" ? "Women" : "Men", PASSENGERS.filter((p) => p.sex === s)])),
  age: () => banded(
    ["Child, under 13", "13 to 19", "20 to 39", "40 to 59", "60 and over", "Unrecorded"]
      .map((band) => [band, PASSENGERS.filter((p) => ageBand(p.age) === band)])),
  port: () => banded(Object.entries(PORTS).map(([code, name]) =>
    [name, PASSENGERS.filter((p) => p.embarked === code)])),
  relatives: () => banded([
    ["Alone", PASSENGERS.filter((p) => p.relatives === 0)],
    ["One or two", PASSENGERS.filter((p) => p.relatives >= 1 && p.relatives <= 2)],
    ["Three or more", PASSENGERS.filter((p) => p.relatives >= 3)],
  ]),
};

const app = new App({
  name: "titanic",
  version: "1.0.0",
  instructions:
    "891 real passenger records from the Titanic. Every tool answers with a "
    + "drawing in text as well as the data, so the answer reads correctly in a "
    + "terminal with no view. Quote the chart back rather than describing it.",
});

const view = (name: string) => {
  try {
    return readFileSync(path.join(HERE, `${name}.html`), "utf8");
  } catch {
    // The views are optional here: this example is mostly about the half of
    // the answer that survives without one.
    return `<!doctype html><meta charset="utf-8"><p>No view built for ${name}.</p>`;
  }
};
app.view("ui://titanic/survival", { html: view("view") });
app.view("ui://titanic/ages", { html: view("view") });
app.view("ui://titanic/passengers", { html: view("view") });

app.implement(contracts, {
  survival_by: async ({ by = "class" }) => {
    const build = GROUPS[by];
    if (!build) throw new UserError(`Cannot group by ${by}.`);
    const groups = build();
    const overall = { ...rate(PASSENGERS), band: "Everyone aboard" };

    const chart = section(
      `Survival by ${by}, of 891 passengers`,
      // Against 100 rather than against the largest band: a rate scaled to
      // its own maximum draws 63% as a full bar, and the overall line below
      // has to be on the same scale to be worth putting there at all.
      `${bars({
        rows: [...groups, overall], label: "band", value: "rate", width: 34,
        unit: "%", max: 100, format: (n) => n.toFixed(1),
      })}`);

    return { by, bands: groups, overall, chart };
  },

  age_distribution: async ({ survived, buckets = 10 }) => {
    const pool = survived === undefined
      ? PASSENGERS
      : PASSENGERS.filter((p) => p.survived === survived);
    const ages = pool.map((p) => p.age).filter((a): a is number => a !== null);
    const sorted = [...ages].sort((a, b) => a - b);
    const median = sorted.length
      ? sorted[Math.floor(sorted.length / 2)] ?? 0
      : 0;

    const who = survived === undefined
      ? "all passengers"
      : survived ? "survivors" : "those lost";

    return {
      ages,
      counted: ages.length,
      unknown: pool.length - ages.length,
      median,
      chart: section(
        `Ages of ${who}`,
        `${histogram({ values: ages, buckets, width: 30 })}\n\nMedian age ${median}.`),
    };
  },

  passengers: async ({ klass, sex, survived, sort = "fare", limit = 20 }) => {
    let matched = PASSENGERS;
    if (klass !== undefined) matched = matched.filter((p) => p.klass === klass);
    if (sex !== undefined) matched = matched.filter((p) => p.sex === sex);
    if (survived !== undefined) matched = matched.filter((p) => p.survived === survived);

    const sorted = [...matched].sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "age") return (b.age ?? -1) - (a.age ?? -1);
      return b.fare - a.fare;
    });
    const shown = sorted.slice(0, Math.max(1, limit));

    return {
      passengers: shown,
      matched: matched.length,
      shown: shown.length,
      table: table({
        rows: sorted,
        limit: Math.max(1, limit),
        markdown: true,
        columns: [
          { key: "name", label: "Name" },
          { key: "klass", label: "Class", align: "end" },
          { key: "sex", label: "Sex" },
          {
            key: "age", label: "Age", align: "end",
            // An unrecorded age says so rather than printing as a number that
            // was never measured.
            format: (value) => (value === null ? "—" : String(value)),
          },
          {
            key: "fare", label: "Fare", align: "end",
            format: (value) => `£${Number(value).toFixed(2)}`,
          },
          {
            key: "survived", label: "Outcome",
            format: (value) => (value ? "survived" : "lost"),
          },
        ],
      }),
    };
  },

  who_survived: async () => {
    const women = PASSENGERS.filter((p) => p.sex === "female");
    const men = PASSENGERS.filter((p) => p.sex === "male");
    const children = PASSENGERS.filter((p) => p.age !== null && p.age < 13);

    const counts = {
      aboard: PASSENGERS.length,
      survived: PASSENGERS.filter((p) => p.survived).length,
      lost: PASSENGERS.filter((p) => !p.survived).length,
      womenSurvived: women.filter((p) => p.survived).length,
      menSurvived: men.filter((p) => p.survived).length,
      childrenSurvived: children.filter((p) => p.survived).length,
    };

    return {
      counts,
      diagram: mermaid({
        title: "Who survived, of the 891 recorded passengers",
        direction: "LR",
        nodes: [
          { id: "aboard", label: `Aboard: ${counts.aboard}`, shape: "round" },
          { id: "women", label: `Women: ${women.length}` },
          { id: "men", label: `Men: ${men.length}` },
          { id: "kids", label: `Children under 13: ${children.length}` },
          { id: "lived", label: `Survived: ${counts.survived}`, shape: "store" },
          { id: "lost", label: `Lost: ${counts.lost}`, shape: "store" },
        ],
        edges: [
          { from: "aboard", to: "women" },
          { from: "aboard", to: "men" },
          { from: "aboard", to: "kids" },
          { from: "women", to: "lived", label: `${counts.womenSurvived} of ${women.length}` },
          { from: "men", to: "lived", label: `${counts.menSurvived} of ${men.length}` },
          { from: "kids", to: "lived", label: `${counts.childrenSurvived} of ${children.length}` },
          { from: "women", to: "lost", label: `${women.length - counts.womenSurvived}` },
          { from: "men", to: "lost", label: `${men.length - counts.menSurvived}` },
        ],
      }),
    };
  },
});

/* The shim in front, because Claude Code opens with `initialize` like every
 * other shipping host. `docs/findings/001` records this server being
 * unreachable from Claude Code without it. */
app.serve({
  legacy: process.env["NGMCP_STRICT"] === "1" ? false : { clientName: "claude-code" },
});
