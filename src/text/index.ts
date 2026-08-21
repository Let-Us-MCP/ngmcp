/** The same shape, drawn in text.
 *
 * A tool answers twice: `structuredContent` carries the data and `content`
 * carries a sentence for the model. That split assumes the host can render the
 * first half. Plenty cannot — a terminal client, a log, a host that fetched a
 * `ui://` resource and never made the frame — and in all of those the second
 * half is the whole answer.
 *
 * The usual response is to write a sentence: "survival was higher in first
 * class". That is a description of a result rather than the result, and it is
 * exactly the flattening an app exists to stop. A bar chart in twelve
 * characters of monospace is not a consolation prize; in a terminal it **is**
 * the rendering, and it carries the numbers rather than an impression of them.
 *
 * So: the same data, two renderers. `src/view/charts/` draws SVG for a host
 * with a frame. This draws text for one without. Neither is a fallback for the
 * other, and a tool that ships both works everywhere.
 *
 * Nothing here touches the DOM, so a server imports it directly.
 */

export type TextRow = object;

const cell = (row: TextRow, key: string): unknown =>
  (row as Record<string, unknown>)[key];

const numberAt = (row: TextRow, key: string): number => {
  const value = cell(row, key);
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
};

const textAt = (row: TextRow, key: string): string => {
  const value = cell(row, key);
  return value === null || value === undefined ? "" : String(value);
};

/** Blocks rather than a single character, so a bar has eight times the
 *  resolution of its width. A chart of ten columns then distinguishes values
 *  a tenth apart instead of rounding them together. */
const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const;
const FULL = "█";

/** ASCII only, for a terminal or font that has no block characters. */
const ASCII_FULL = "#";

export interface BarOptions<R extends TextRow = TextRow> {
  rows: readonly R[];
  /** The field naming each bar. */
  label: string;
  /** The field holding its length. */
  value: string;
  /** Characters the longest bar may use. */
  width?: number;
  /** Printed after each value. */
  unit?: string;
  format?: (value: number) => string;
  /** Bars from zero rather than from the smallest value. Default true, and
   *  changing it is how a chart comes to exaggerate a small difference. */
  zeroBased?: boolean;
  /** The value a full-width bar means.
   *
   * Without it the largest value in the set is full width, which is right for
   * a count and wrong for a percentage: 63% drawn as a full bar reads as
   * everyone, and it reads that way most strongly to whoever is skimming.
   * Set it to 100 for a rate. It also makes two charts comparable, which they
   * are not when each is scaled to its own maximum. */
  max?: number;
  /** Block characters, or `#` where those will not render. */
  charset?: "blocks" | "ascii";
}

const pad = (text: string, to: number): string =>
  text.length >= to ? text : text + " ".repeat(to - text.length);

const padStart = (text: string, to: number): string =>
  text.length >= to ? text : " ".repeat(to - text.length) + text;

/** A horizontal bar chart, one row per bar.
 *
 * Every bar carries its own number as text. A bar whose value can only be read
 * by measuring it against an axis is a picture; with the number beside it, it
 * is a table that also happens to show shape.
 */
export function bars<R extends TextRow>(options: BarOptions<R>): string {
  const {
    rows, label, value, width = 32, unit = "", zeroBased = true,
    charset = "blocks",
  } = options;
  if (!rows.length) return "(no rows)";

  const format = options.format ?? ((n: number) => String(Math.round(n * 100) / 100));
  const values = rows.map((row) => numberAt(row, value));
  const high = options.max ?? Math.max(...values);
  const low = zeroBased ? Math.min(0, ...values) : Math.min(...values);
  const span = high - low || 1;

  const labelWidth = Math.max(...rows.map((row) => textAt(row, label).length));
  const valueWidth = Math.max(...values.map((v) => `${format(v)}${unit}`.length));

  return rows.map((row) => {
    const n = numberAt(row, value);
    const filled = ((n - low) / span) * width;
    const whole = Math.floor(filled);
    const rest = Math.round((filled - whole) * 8);
    const bar = charset === "ascii"
      ? ASCII_FULL.repeat(Math.max(0, Math.round(filled)))
      : FULL.repeat(Math.max(0, whole)) + (EIGHTHS[rest] ?? "");
    return `${pad(textAt(row, label), labelWidth)}  `
      + `${pad(bar, width)}  ${padStart(`${format(n)}${unit}`, valueWidth)}`;
  }).join("\n");
}

export interface HistogramOptions {
  values: readonly number[];
  /** How many buckets. More than the data supports reads as noise. */
  buckets?: number;
  width?: number;
  format?: (value: number) => string;
  charset?: "blocks" | "ascii";
}

/** A distribution, bucketed.
 *
 * The bucket edges are printed, because a histogram whose axis is implied is a
 * shape nobody can check against anything.
 */
export function histogram(options: HistogramOptions): string {
  const { values, buckets = 10, width = 32, charset = "blocks" } = options;
  const usable = values.filter((v) => Number.isFinite(v));
  if (!usable.length) return "(no values)";

  const format = options.format ?? ((n: number) => String(Math.round(n * 10) / 10));
  const low = Math.min(...usable);
  const high = Math.max(...usable);
  const span = (high - low) || 1;
  const step = span / buckets;

  const counts = new Array<number>(buckets).fill(0);
  for (const v of usable) {
    // The topmost value belongs in the last bucket rather than in one past it.
    const index = Math.min(buckets - 1, Math.floor((v - low) / step));
    counts[index] = (counts[index] ?? 0) + 1;
  }

  const rows = counts.map((count, i) => ({
    range: `${format(low + step * i)}–${format(low + step * (i + 1))}`,
    count,
  }));
  return bars({
    rows, label: "range", value: "count", width, charset,
    format: (n) => String(Math.round(n)),
  });
}

const TICKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/** A line the width of a word.
 *
 * Returned with its range, because eight levels of block cannot carry a scale
 * and a sparkline without one is decoration.
 */
export function sparkline(values: readonly number[]): string {
  const usable = values.filter((v) => Number.isFinite(v));
  if (!usable.length) return "";
  const low = Math.min(...usable);
  const high = Math.max(...usable);
  const span = high - low || 1;
  return usable.map((v) => {
    const at = Math.round(((v - low) / span) * (TICKS.length - 1));
    return TICKS[Math.min(TICKS.length - 1, Math.max(0, at))];
  }).join("");
}

export interface TableColumn {
  key: string;
  label: string;
  align?: "start" | "end";
  format?: (value: unknown, row: TextRow) => string;
}

export interface TableOptions<R extends TextRow = TextRow> {
  rows: readonly R[];
  columns: readonly TableColumn[];
  /** Stop after this many rows and say how many were left. */
  limit?: number;
  /** GitHub-flavoured markdown, for a host that renders it. */
  markdown?: boolean;
}

/** A table, in text.
 *
 * `markdown: true` produces the pipe table a markdown host renders and a
 * terminal still reads. The alignment row is what makes numbers line up in
 * both, so it is not optional.
 */
export function table<R extends TextRow>(options: TableOptions<R>): string {
  const { rows, columns, limit = 0, markdown = false } = options;
  if (!columns.length) return "";
  const shown = limit > 0 ? rows.slice(0, limit) : rows;

  const render = (row: R, column: TableColumn): string => {
    const raw = cell(row, column.key);
    return column.format ? column.format(raw, row) : textAt(row, column.key);
  };

  const widths = columns.map((column, i) => Math.max(
    column.label.length,
    ...shown.map((row) => render(row, column).length),
    // A markdown alignment cell needs three characters to say which way.
    markdown ? 3 : 0,
    i === -1 ? 0 : 0,
  ));

  const line = (cells: string[]) => markdown
    ? `| ${cells.join(" | ")} |`
    : cells.join("  ");

  const head = line(columns.map((column, i) =>
    column.align === "end"
      ? padStart(column.label, widths[i]!)
      : pad(column.label, widths[i]!)));

  const rule = markdown
    ? line(columns.map((column, i) => (column.align === "end"
        ? `${"-".repeat(widths[i]! - 1)}:`
        : "-".repeat(widths[i]!))))
    : columns.map((_, i) => "-".repeat(widths[i]!)).join("  ");

  const body = shown.map((row) => line(columns.map((column, i) =>
    column.align === "end"
      ? padStart(render(row, column), widths[i]!)
      : pad(render(row, column), widths[i]!))));

  const out = [head, rule, ...body];
  if (limit > 0 && rows.length > limit) {
    // Silently truncating is how a reader comes to believe a list is complete.
    out.push(`… and ${rows.length - limit} more`);
  }
  return out.join("\n");
}

export interface MermaidNode {
  id: string;
  label: string;
  /** `[]` box, `()` rounded, `{}` decision, `[()]` store. */
  shape?: "box" | "round" | "decision" | "store";
}

export interface MermaidEdge {
  from: string;
  to: string;
  label?: string;
}

export interface MermaidOptions {
  nodes: readonly MermaidNode[];
  edges: readonly MermaidEdge[];
  direction?: "TD" | "LR";
  title?: string;
}

const SHAPES: Record<string, [string, string]> = {
  box: ["[", "]"],
  round: ["(", ")"],
  decision: ["{", "}"],
  store: ["[(", ")]"],
};

/** A mermaid `flowchart` block.
 *
 * Emitted as a fenced block because that is what a markdown host renders and
 * what every other host shows as readable source. No parser and no renderer
 * here: this writes the diagram, and whoever is reading decides whether they
 * can draw it.
 *
 * Labels are quoted, because an unquoted label containing a bracket or a pipe
 * ends the node early and produces a diagram that is wrong rather than absent,
 * which is the worse of the two.
 */
export function mermaid(options: MermaidOptions): string {
  const { nodes, edges, direction = "TD", title } = options;
  const quote = (text: string) => `"${text.replace(/"/g, "'")}"`;
  const lines = [`flowchart ${direction}`];
  for (const node of nodes) {
    const [open, close] = SHAPES[node.shape ?? "box"] ?? SHAPES["box"]!;
    lines.push(`  ${node.id}${open}${quote(node.label)}${close}`);
  }
  for (const edge of edges) {
    lines.push(edge.label
      ? `  ${edge.from} -->|${quote(edge.label)}| ${edge.to}`
      : `  ${edge.from} --> ${edge.to}`);
  }
  const block = ["```mermaid", ...lines, "```"].join("\n");
  return title ? `**${title}**\n\n${block}` : block;
}

/** Everything above, with a heading, for a tool's `content`. */
export function section(title: string, body: string): string {
  return `${title}\n${"─".repeat(Math.min(60, title.length))}\n${body}`;
}
