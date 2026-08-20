/** Charts, as inline SVG.
 *
 * The ceiling on a structured response is the expressiveness of the component
 * library, and a month of latency is a line rather than a paragraph. These are
 * Panes: they draw a shape and know nothing about where it came from, so the
 * rows that fill a `dataTable` fill a `lineChart` unchanged.
 *
 * Drawn by hand rather than with a charting library, and the reason is the
 * sandbox rather than taste. A view runs in a frame with an opaque origin and
 * a restrictive default CSP, and nothing can be fetched from inside it, so a
 * dependency that loads anything at runtime does not work at all and one that
 * does not still has to be inlined into every view that draws a line.
 *
 * Three things every chart here does that a charting library does not:
 *
 * - **The numbers are readable, not just the picture.** Every chart carries a
 *   visually hidden `<table>` of the values it drew. A summary saying "trending
 *   up" is a description of a chart; the table is the chart's data, which is
 *   what the reader actually came for and what the model was told about.
 * - **A keyboard route through the data.** The plot is one tab stop. Arrows
 *   move point to point, Home and End jump to the ends, and the point under
 *   the cursor is announced and marked. A chart nobody can step through is a
 *   picture of a result rather than a result.
 * - **The locale comes from the host.** `Intl.NumberFormat()` with no locale
 *   disagrees between engines on the same machine.
 */
import { computed, effect, signal, type Signal } from "../reactive.js";
import { h, svg, list, read, uid, type Child, type Reactive } from "../dom.js";

export type ChartRow = object;

const cell = (row: ChartRow, key: string): unknown =>
  (row as Record<string, unknown>)[key];

const numberAt = (row: ChartRow, key: string): number => {
  const value = cell(row, key);
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
};

export interface Series {
  /** The field holding this series' value. */
  key: string;
  label: string;
  /** Any CSS colour. Left alone, the chart's own palette is used in order. */
  color?: string;
}

export interface ChartOptions<R extends ChartRow = ChartRow> {
  rows: Reactive<readonly R[]>;
  /** The field along the bottom. Values may be numbers, dates or categories. */
  x: string;
  /** What the x axis is called, for the reader and for the hidden table. */
  xLabel?: string;
  series: readonly Series[];
  /** Names the chart. Required, because an unnamed figure is an ornament. */
  title: string;
  /** Said before the numbers: what the reader is meant to take from it. */
  description?: string;
  /** From `hostContext.locale`. Never rely on the engine's default. */
  locale?: Reactive<string | undefined>;
  /** Drawing space. The chart scales to its container; this is its ratio. */
  width?: number;
  height?: number;
  /** Start the value axis at zero even when the data does not. */
  zeroBased?: boolean;
  format?: (value: number) => string;
  /** Called with the row the reader moved to, by pointer or by keyboard. */
  onPoint?: (row: R, index: number) => void;
}

export interface Chart {
  el: HTMLElement;
  /** Which point the reader is on, or -1. Moves with the keyboard. */
  cursor: Signal<number>;
  /** What a screen reader is told, and what a tool summary can quote. */
  description: Signal<string>;
}

/* Chosen for order rather than for looks: adjacent series stay distinguishable
 * when the frame is small, and every one of them carries a shape or a label as
 * well, because colour alone is not a channel everybody has. */
const PALETTE = [
  "#0a84ff", "#ff9f0a", "#30d158", "#ff375f", "#bf5af2", "#64d2ff",
];

const PAD = { top: 16, right: 16, bottom: 34, left: 48 };

interface Scale {
  (value: number): number;
  domain: readonly [number, number];
  ticks(count: number): number[];
}

const linear = (
  domain: readonly [number, number], range: readonly [number, number],
): Scale => {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  const scale = ((value: number) => r0 + ((value - d0) / span) * (r1 - r0)) as Scale;
  scale.domain = domain;
  scale.ticks = (count) => {
    const step = span / Math.max(1, count - 1);
    return Array.from({ length: count }, (_, i) => d0 + step * i);
  };
  return scale;
};

const extent = (values: readonly number[]): [number, number] => {
  if (!values.length) return [0, 1];
  let low = values[0]!, high = values[0]!;
  for (const v of values) { if (v < low) low = v; if (v > high) high = v; }
  return low === high ? [low, low + 1] : [low, high];
};

/** What the bottom axis says for a row: a category as written, a date as a
 *  date, a number as a number. */
const xText = (value: unknown, locale: string | undefined): string => {
  if (value instanceof Date) return value.toLocaleDateString(locale);
  if (typeof value === "number") return new Intl.NumberFormat(locale).format(value);
  return String(value ?? "");
};

interface Frame<R extends ChartRow> {
  el: HTMLElement;
  plot: SVGElement;
  cursor: Signal<number>;
  description: Signal<string>;
  rows: () => readonly R[];
  format: () => (value: number) => string;
  locale: () => string | undefined;
  colorOf: (index: number) => string;
}

/** Everything a chart has that is not its marks.
 *
 * The figure, the caption, the hidden table of numbers, the live region, the
 * keyboard route, and the summary. Each chart supplies only what it draws. */
function frame<R extends ChartRow>(
  options: ChartOptions<R>,
  kind: string,
  summarise: (rows: readonly R[], format: (v: number) => string) => string,
): Frame<R> {
  const { title, x, series, xLabel } = options;
  const titleId = uid(`chart-title`);
  const rows = computed(() => read(options.rows));
  const locale = computed(() =>
    options.locale ? read(options.locale) : undefined);
  const format = computed(() => options.format
    ?? ((value: number) => new Intl.NumberFormat(locale()).format(value)));
  const cursor = signal(-1);
  const colorOf = (index: number) =>
    series[index]?.color ?? PALETTE[index % PALETTE.length]!;

  const plot = svg("svg", {
    // Not `chart-${kind}`: the marks a line chart draws are already called
    // `chart-line`, and a plot answering to its own marks' name makes every
    // selector in every test one element too generous.
    class: `chart-plot chart-plot-${kind}`,
    viewBox: `0 0 ${options.width ?? 640} ${options.height ?? 240}`,
    preserveAspectRatio: "xMidYMid meet",
    role: "img",
    "aria-labelledby": titleId,
  });

  const description = computed(() => {
    const current = rows();
    const summary = summarise(current, format());
    return options.description
      ? `${title}. ${options.description} ${summary}`
      : `${title}. ${summary}`;
  });

  // Read out when the reader moves, and silent otherwise. The whole chart is
  // not re-announced on every arrow key: only where they now are.
  const at = computed(() => {
    const index = cursor();
    const current = rows();
    const row = current[index];
    if (!row) return "";
    const parts = series.map((s) => `${s.label} ${format()(numberAt(row, s.key))}`);
    return `${xText(cell(row, x), locale())}, ${parts.join(", ")}`;
  });

  const move = (delta: number) => {
    const count = rows().length;
    if (!count) return;
    const from = cursor();
    const next = from < 0
      ? (delta > 0 ? 0 : count - 1)
      : Math.min(count - 1, Math.max(0, from + delta));
    cursor.set(next);
    const row = rows()[next];
    if (row) options.onPoint?.(row, next);
  };

  const figure = h("figure", { class: `chart chart-${kind}-figure` },
    h("figcaption", { class: "chart-title", id: titleId, text: title }),
    options.description
      ? h("p", { class: "chart-description", text: options.description }) : null,
    h("div", {
      class: "chart-canvas",
      tabindex: "0",
      role: "application",
      "aria-labelledby": titleId,
      "aria-describedby": `${titleId}-hint`,
      onkeydown: (event: KeyboardEvent) => {
        const key = event.key;
        if (key === "ArrowRight") { event.preventDefault(); move(1); }
        else if (key === "ArrowLeft") { event.preventDefault(); move(-1); }
        else if (key === "Home") { event.preventDefault(); cursor.set(0); }
        else if (key === "End") { event.preventDefault(); cursor.set(rows().length - 1); }
        else if (key === "Escape") { cursor.set(-1); }
      },
      onblur: () => cursor.set(-1),
    }, plot),
    h("span", {
      class: "sr-only", id: `${titleId}-hint`,
      text: "Arrow keys move between points. Escape leaves the point.",
    }),
    h("p", { class: "chart-readout", role: "status", "aria-live": "polite",
      text: at, hidden: computed(() => at() === "") }),
    // The numbers themselves, for a reader who cannot see the marks. A chart
    // that offers only a summary has flattened its data back into a sentence,
    // which is the thing an app exists to stop doing.
    h("table", { class: "sr-only chart-data" },
      h("caption", { text: `${title}, as a table` }),
      h("thead", {}, h("tr", {},
        h("th", { scope: "col", text: xLabel ?? x }),
        ...series.map((s) => h("th", { scope: "col", text: s.label })))),
      h("tbody", {}, list(rows, (row) => h("tr", {},
        h("th", { scope: "row", text: xText(cell(row, x), locale()) }),
        ...series.map((s) => h("td", { text: format()(numberAt(row, s.key)) })))))),
  );

  return {
    el: figure, plot, cursor, description, rows, format, locale, colorOf,
  };
}

/** Axes, gridlines and the marks a chart hands over, in one drawing space. */
function grid<R extends ChartRow>(
  f: Frame<R>,
  options: ChartOptions<R>,
  valuesOf: (rows: readonly R[]) => number[],
  draw: (space: {
    rows: readonly R[];
    xAt: (index: number) => number;
    yAt: (value: number) => number;
    width: number; height: number; left: number; top: number;
  }) => Child[],
): void {
  const width = options.width ?? 640;
  const height = options.height ?? 240;
  const inner = { w: width - PAD.left - PAD.right, h: height - PAD.top - PAD.bottom };

  // Reads the rows, so a panel whose tool answered again redraws and only the
  // marks are rebuilt. The cursor line is built once, outside, because it
  // belongs to the reader rather than to the data.
  const xAt = (index: number) => {
    const count = f.rows().length;
    return count <= 1
      ? PAD.left + inner.w / 2
      : PAD.left + (index / (count - 1)) * inner.w;
  };
  const cursorLine = svg("line", {
    class: "chart-cursor",
    x1: computed(() => xAt(Math.max(0, f.cursor()))),
    x2: computed(() => xAt(Math.max(0, f.cursor()))),
    y1: PAD.top, y2: PAD.top + inner.h,
    visibility: computed(() => (f.cursor() < 0 ? "hidden" : "visible")),
  });

  effect(() => {
  const rows = f.rows();
  const values = valuesOf(rows);

  const [low, high] = extent(values);
  const y = linear(
    [options.zeroBased === false ? low : Math.min(0, low), high],
    [PAD.top + inner.h, PAD.top],
  );

  const marks: Child[] = [];
  for (const tick of y.ticks(4)) {
    const at = y(tick);
    marks.push(svg("line", {
      class: "chart-grid", x1: PAD.left, x2: PAD.left + inner.w, y1: at, y2: at,
    }));
    marks.push(svg("text", {
      class: "chart-tick", x: PAD.left - 6, y: at + 4, "text-anchor": "end",
      text: f.format()(Math.round(tick * 100) / 100),
    }));
  }

  // Labels are thinned rather than rotated: rotated text in a 320 pixel frame
  // is unreadable in both engines, and a label every nth point is not.
  const every = Math.max(1, Math.ceil(rows.length / 6));
  rows.forEach((row, index) => {
    if (index % every !== 0 && index !== rows.length - 1) return;
    marks.push(svg("text", {
      class: "chart-tick chart-tick-x", x: xAt(index), y: height - PAD.bottom + 18,
      "text-anchor": "middle", text: xText(cell(row, options.x), f.locale()),
    }));
  });

  marks.push(svg("line", {
    class: "chart-axis", x1: PAD.left, x2: PAD.left + inner.w,
    y1: PAD.top + inner.h, y2: PAD.top + inner.h,
  }));

  for (const mark of draw({
    rows, xAt, yAt: y, width: inner.w, height: inner.h,
    left: PAD.left, top: PAD.top,
  })) {
    if (mark instanceof Node) marks.push(mark);
  }

  // Where the keyboard is, drawn so a sighted keyboard user can see it too.
  marks.push(cursorLine);
  f.plot.replaceChildren(...marks.filter((m): m is Node => m instanceof Node));
  });
}

const trend = (values: readonly number[]): string => {
  if (values.length < 2) return "";
  const first = values[0]!, last = values[values.length - 1]!;
  if (last === first) return ", flat";
  return last > first ? ", rising" : ", falling";
};

const summaryOf = (
  label: string, values: readonly number[], format: (v: number) => string,
): string => {
  if (!values.length) return `${label}: no data.`;
  const [low, high] = extent(values);
  return `${label}: ${values.length} points, from ${format(low)} to ${format(high)}`
    + `, last ${format(values[values.length - 1]!)}${trend(values)}.`;
};

const seriesSummary = <R extends ChartRow>(
  series: readonly Series[],
) => (rows: readonly R[], format: (v: number) => string): string =>
  series.map((s) => summaryOf(s.label, rows.map((r) => numberAt(r, s.key)), format))
    .join(" ");

const path = (points: readonly [number, number][]): string =>
  points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`).join(" ");

/** A line per series. The default for anything over time. */
export function lineChart<R extends ChartRow>(options: ChartOptions<R>): Chart {
  const f = frame(options, "line", seriesSummary(options.series));
  const values = (rows: readonly R[]) =>
    options.series.flatMap((s) => rows.map((r) => numberAt(r, s.key)));

  grid(f, options, values, ({ rows, xAt, yAt }) => [
    ...options.series.map((s, i) => svg("path", {
      class: "chart-line", fill: "none", stroke: f.colorOf(i), "stroke-width": 2,
      d: path(rows.map((row, index) => [xAt(index), yAt(numberAt(row, s.key))])),
    })),
    ...options.series.flatMap((s, i) => rows.map((row, index) => svg("circle", {
      class: "chart-point", cx: xAt(index), cy: yAt(numberAt(row, s.key)),
      r: 3, fill: f.colorOf(i),
    }))),
  ]);
  return { el: f.el, cursor: f.cursor, description: f.description };
}

/** A line with the area under it filled. The same shape, read as a volume. */
export function areaChart<R extends ChartRow>(options: ChartOptions<R>): Chart {
  const f = frame(options, "area", seriesSummary(options.series));
  const values = (rows: readonly R[]) =>
    options.series.flatMap((s) => rows.map((r) => numberAt(r, s.key)));

  grid(f, options, values, ({ rows, xAt, yAt, top, height }) => [
    ...options.series.map((s, i) => {
      const points = rows.map((row, index): [number, number] =>
        [xAt(index), yAt(numberAt(row, s.key))]);
      const base = top + height;
      const first = points[0]?.[0] ?? 0;
      const last = points[points.length - 1]?.[0] ?? 0;
      return svg("path", {
        class: "chart-area", fill: f.colorOf(i), "fill-opacity": 0.25,
        stroke: f.colorOf(i), "stroke-width": 2,
        d: `${path(points)} L${last.toFixed(2)} ${base} L${first.toFixed(2)} ${base} Z`,
      });
    }),
  ]);
  return { el: f.el, cursor: f.cursor, description: f.description };
}

/** Bars, grouped when there is more than one series. For categories. */
export function barChart<R extends ChartRow>(options: ChartOptions<R>): Chart {
  const f = frame(options, "bar", seriesSummary(options.series));
  const values = (rows: readonly R[]) =>
    options.series.flatMap((s) => rows.map((r) => numberAt(r, s.key)));

  grid(f, options, values, ({ rows, xAt, yAt, width, top, height }) => {
    const slot = rows.length ? (width / rows.length) * 0.7 : width;
    const each = slot / Math.max(1, options.series.length);
    const base = yAt(0);
    return options.series.flatMap((s, i) => rows.map((row, index) => {
      const value = numberAt(row, s.key);
      const y = yAt(value);
      return svg("rect", {
        class: "chart-bar", fill: f.colorOf(i),
        x: xAt(index) - slot / 2 + i * each,
        // A bar drawn from the axis rather than from the top of the frame, so
        // a negative value goes down from zero instead of off the picture.
        y: Math.min(y, base),
        width: Math.max(1, each - 2),
        height: Math.max(1, Math.abs(base - y)),
      });
    })).concat([
      svg("line", { class: "chart-axis", x1: PAD.left, x2: PAD.left + width,
        y1: base, y2: base }),
      svg("rect", { class: "chart-frame", x: PAD.left, y: top,
        width, height, fill: "none" }),
    ]);
  });
  return { el: f.el, cursor: f.cursor, description: f.description };
}

/** One mark per row, positioned by two fields. For a relationship. */
export function scatterChart<R extends ChartRow>(
  options: ChartOptions<R> & { xValue: string },
): Chart {
  const f = frame(options, "scatter", seriesSummary(options.series));
  const values = (rows: readonly R[]) =>
    options.series.flatMap((s) => rows.map((r) => numberAt(r, s.key)));

  grid(f, options, values, ({ rows, yAt, width, left }) => {
    const xScale = linear(
      extent(rows.map((r) => numberAt(r, options.xValue))), [left, left + width]);
    return options.series.flatMap((s, i) => rows.map((row) => svg("circle", {
      class: "chart-point", r: 4, fill: f.colorOf(i), "fill-opacity": 0.75,
      cx: xScale(numberAt(row, options.xValue)),
      cy: yAt(numberAt(row, s.key)),
    })));
  });
  return { el: f.el, cursor: f.cursor, description: f.description };
}

export interface SparklineOptions<R extends ChartRow = ChartRow> {
  rows: Reactive<readonly R[]>;
  key: string;
  label: string;
  x?: string;
  color?: string;
  width?: number;
  height?: number;
  locale?: Reactive<string | undefined>;
  format?: (value: number) => string;
}

/** A line the size of a word, for putting a number in context.
 *
 * No axes, no cursor and no tab stop, because there is nothing here to
 * operate: it is one glyph. The keyboard route obligation is met by the data
 * being somewhere a reader can actually get at, which is the hidden table,
 * rather than by making a 24 pixel picture focusable.
 */
export function sparkline<R extends ChartRow>(options: SparklineOptions<R>): Chart {
  const width = options.width ?? 120;
  const height = options.height ?? 28;
  const rows = computed(() => read(options.rows));
  const locale = computed(() => options.locale ? read(options.locale) : undefined);
  const format = computed(() => options.format
    ?? ((value: number) => new Intl.NumberFormat(locale()).format(value)));

  const values = computed(() => rows().map((r) => numberAt(r, options.key)));
  const description = computed(() =>
    summaryOf(options.label, values(), format()));

  const d = computed(() => {
    const current = values();
    if (!current.length) return "";
    const y = linear(extent(current), [height - 2, 2]);
    return path(current.map((value, index): [number, number] => [
      current.length <= 1 ? width / 2 : (index / (current.length - 1)) * width,
      y(value),
    ]));
  });

  const el = h("span", { class: "sparkline" },
    svg("svg", {
      class: "sparkline-plot", viewBox: `0 0 ${width} ${height}`,
      role: "img", "aria-label": description,
    }, svg("path", {
      fill: "none", stroke: options.color ?? PALETTE[0]!, "stroke-width": 1.5, d,
    })),
    h("table", { class: "sr-only" },
      h("caption", { text: options.label }),
      h("tbody", {}, list(rows, (row, index) => h("tr", {},
        h("th", { scope: "row",
          text: options.x ? xText(cell(row, options.x), locale()) : String(index + 1) }),
        h("td", { text: format()(numberAt(row, options.key)) }))))));

  return { el, cursor: signal(-1), description };
}

export interface HeatmapOptions<R extends ChartRow = ChartRow> {
  rows: Reactive<readonly R[]>;
  /** The field naming each row of the grid. */
  row: string;
  /** The fields making up the columns, in order. */
  columns: readonly Series[];
  title: string;
  description?: string;
  locale?: Reactive<string | undefined>;
  format?: (value: number) => string;
  /** The colour at the top of the range. The bottom is the frame's own. */
  color?: string;
}

/** A grid coloured by value.
 *
 * Every cell carries its number as text as well as its colour, because a
 * colour is not a channel every reader has and a heatmap that only encodes
 * value as lightness is unreadable to some proportion of them.
 */
export function heatmap<R extends ChartRow>(options: HeatmapOptions<R>): Chart {
  const titleId = uid("chart-title");
  const rows = computed(() => read(options.rows));
  const locale = computed(() => options.locale ? read(options.locale) : undefined);
  const format = computed(() => options.format
    ?? ((value: number) => new Intl.NumberFormat(locale()).format(value)));
  const values = computed(() =>
    rows().flatMap((r) => options.columns.map((c) => numberAt(r, c.key))));

  const description = computed(() =>
    summaryOf(options.title, values(), format()));

  const shade = (value: number): number => {
    const [low, high] = extent(values());
    return high === low ? 0.5 : (value - low) / (high - low);
  };

  const table = h("table", { class: "heatmap", "aria-labelledby": titleId },
    h("caption", { class: "chart-title", id: titleId, text: options.title }),
    h("thead", {}, h("tr", {},
      h("th", { scope: "col", text: options.row },),
      ...options.columns.map((c) => h("th", { scope: "col", text: c.label })))),
    h("tbody", {}, list(rows, (row) => h("tr", {},
      h("th", { scope: "row", text: String(cell(row, options.row) ?? "") }),
      ...options.columns.map((c) => {
        const value = numberAt(row, c.key);
        return h("td", {
          class: "heatmap-cell",
          style: { background: options.color ?? PALETTE[0]!,
            // Opacity rather than a colour ramp, so the cell keeps one hue and
            // the text on it keeps one contrast rule.
            opacity: String(0.12 + shade(value) * 0.88) },
          text: format()(value),
        });
      })))));

  const el = h("figure", { class: "chart chart-heatmap" },
    options.description
      ? h("p", { class: "chart-description", text: options.description }) : null,
    table);

  return { el, cursor: signal(-1), description };
}
