import test from "node:test";
import assert from "node:assert/strict";
import { bars, histogram, sparkline, table, mermaid, section } from "../../dist/index.js";

/* The text renderers exist for hosts with no frame, where this is not a
 * fallback but the whole rendering. So the tests are about whether the numbers
 * survive the drawing, not about whether it looks nice. */

const CLASSES = [
  { klass: "First", rate: 62.96 },
  { klass: "Second", rate: 47.28 },
  { klass: "Third", rate: 24.24 },
];

test("a bar carries its own number, not only its length", () => {
  /* A bar that can only be read by measuring it against an axis is a picture.
   * With the number beside it, it is a table that also shows shape. */
  const drawn = bars({ rows: CLASSES, label: "klass", value: "rate", width: 20, unit: "%" });
  const lines = drawn.split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^First /);
  assert.match(lines[0], /62\.96%$/);
  assert.match(lines[2], /24\.24%$/);
});

test("bars are proportional to their values", () => {
  const drawn = bars({ rows: CLASSES, label: "klass", value: "rate", width: 20 });
  const filled = drawn.split("\n").map((line) =>
    (line.match(/[█▏▎▍▌▋▊▉]/g) ?? []).length);
  assert.ok(filled[0] > filled[1], "first class is not the longest bar");
  assert.ok(filled[1] > filled[2], "second class is not longer than third");
});

test("bars start at zero, so a small difference is not made to look large", () => {
  /* Scaling from the smallest value turns 62 against 58 into a bar four times
   * the length of another, which is a lie told with a true number. */
  const close = [{ k: "a", v: 62 }, { k: "b", v: 58 }];
  const honest = bars({ rows: close, label: "k", value: "v", width: 20 });
  const stretched = bars({ rows: close, label: "k", value: "v", width: 20, zeroBased: false });
  const count = (text) => text.split("\n").map((l) => (l.match(/[█▏▎▍▌▋▊▉]/g) ?? []).length);
  const [aHonest, bHonest] = count(honest);
  assert.ok(bHonest / aHonest > 0.8, "a four point difference was drawn as a large one");
  assert.equal(count(stretched)[1], 0, "the opt-out no longer starts from the smallest");
});

test("a percentage chart is drawn against 100, not against its own largest", () => {
  /* Scaled to its own maximum, 63% is a full-width bar, which reads as
   * everyone — and reads that way most strongly to whoever is skimming. It
   * also makes two charts of the same thing incomparable. */
  const drawn = bars({
    rows: CLASSES, label: "klass", value: "rate", width: 20, unit: "%", max: 100,
  });
  const filled = drawn.split("\n").map((line) =>
    (line.match(/[█▏▎▍▌▋▊▉]/g) ?? []).length);
  assert.ok(filled[0] < 20, `63% filled ${filled[0]} of 20 characters`);
  assert.ok(filled[0] >= 12 && filled[0] <= 14, `63% of 20 is not ${filled[0]}`);

  // And two charts on the same scale can be read against each other.
  const one = bars({ rows: [CLASSES[0]], label: "klass", value: "rate", width: 20, max: 100 });
  assert.equal((one.match(/[█▏▎▍▌▋▊▉]/g) ?? []).length, filled[0],
    "the same value drew a different bar in a chart of one");
});

test("an empty set says so rather than drawing nothing", () => {
  assert.equal(bars({ rows: [], label: "k", value: "v" }), "(no rows)");
  assert.equal(histogram({ values: [] }), "(no values)");
  assert.equal(sparkline([]), "");
});

test("an ascii charset avoids block characters entirely", () => {
  const drawn = bars({
    rows: CLASSES, label: "klass", value: "rate", width: 10, charset: "ascii",
  });
  assert.match(drawn, /#/);
  assert.doesNotMatch(drawn, /[█▏▎▍▌▋▊▉]/);
});

test("a histogram buckets every value, including the largest", () => {
  /* The topmost value belongs in the last bucket rather than one past it,
   * which is the off-by-one that quietly drops the maximum. */
  const values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const drawn = histogram({ values, buckets: 5, width: 10 });
  const counts = drawn.split("\n").map((line) => Number(line.trim().split(/\s+/).pop()));
  // Both halves: the value has to be counted, and it has to be counted in one
  // of the buckets that were asked for rather than in a sixth one grown to
  // hold it.
  assert.equal(counts.length, 5, `asked for five buckets, got ${counts.length}:\n${drawn}`);
  assert.equal(counts.reduce((a, b) => a + b, 0), values.length,
    `a value fell outside every bucket: ${drawn}`);
});

test("a histogram prints its bucket edges", () => {
  const drawn = histogram({ values: [0, 5, 10], buckets: 2 });
  assert.match(drawn, /0–5/);
  assert.match(drawn, /5–10/);
});

test("a sparkline moves with its values", () => {
  const line = sparkline([1, 5, 9]);
  assert.equal(line.length, 3);
  assert.equal(line[0], "▁");
  assert.equal(line[2], "█");
});

test("a table lines its columns up and keeps the numbers readable", () => {
  const drawn = table({
    rows: CLASSES,
    columns: [
      { key: "klass", label: "Class" },
      { key: "rate", label: "Survived", align: "end" },
    ],
  });
  const lines = drawn.split("\n");
  assert.equal(lines.length, 5);
  // Every line the same width means the columns actually line up.
  const widths = new Set(lines.map((l) => l.length));
  assert.equal(widths.size, 1, `columns do not line up:\n${drawn}`);
});

test("a markdown table is a pipe table with an alignment row", () => {
  const drawn = table({
    rows: CLASSES,
    columns: [
      { key: "klass", label: "Class" },
      { key: "rate", label: "Survived", align: "end" },
    ],
    markdown: true,
  });
  const lines = drawn.split("\n");
  assert.match(lines[0], /^\| Class/);
  assert.match(lines[1], /^\|[- ]+\|[- ]+:? \|$/, `no alignment row: ${lines[1]}`);
  // The alignment row is what makes a number column right-aligned in a
  // markdown host and lined up in a terminal, so it carries the colon.
  assert.match(lines[1], /:\s*\|$/);
  assert.match(lines[2], /^\| First/);
});

test("a truncated table says how much it left out", () => {
  /* Silently stopping is how a reader comes to believe a list is complete. */
  const rows = Array.from({ length: 20 }, (_, i) => ({ n: i }));
  const drawn = table({
    rows, columns: [{ key: "n", label: "N" }], limit: 5,
  });
  assert.equal(drawn.split("\n").filter((l) => /^\d/.test(l.trim())).length, 5);
  assert.match(drawn, /and 15 more/);
});

test("a mermaid block is fenced, so a host renders it and a terminal reads it", () => {
  const drawn = mermaid({
    nodes: [
      { id: "a", label: "Boarded", shape: "round" },
      { id: "b", label: "Survived?", shape: "decision" },
    ],
    edges: [{ from: "a", to: "b", label: "891 passengers" }],
    direction: "LR",
  });
  assert.match(drawn, /^```mermaid\n/);
  assert.match(drawn, /\n```$/);
  assert.match(drawn, /flowchart LR/);
  assert.match(drawn, /a\("Boarded"\)/);
  assert.match(drawn, /b\{"Survived\?"\}/);
  assert.match(drawn, /a -->\|"891 passengers"\| b/);
});

test("a label with a bracket in it does not end the node early", () => {
  /* An unquoted label containing a bracket produces a diagram that is wrong
   * rather than absent, which is the worse of the two. */
  const drawn = mermaid({
    nodes: [{ id: "a", label: 'Fare [pounds] "sterling"' }],
    edges: [],
  });
  assert.match(drawn, /a\["Fare \[pounds\] 'sterling'"\]/);
});

test("a section keeps its heading with its body", () => {
  const drawn = section("Survival by class", "First  ███");
  assert.match(drawn, /^Survival by class\n─+\nFirst/);
});
