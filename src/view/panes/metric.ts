/** One number, and whether it is going the right way.
 *
 * The smallest useful structured response, and the reason a dashboard reads
 * faster than a paragraph. A Pane: it takes a value and knows nothing about
 * where it came from.
 */
import { computed, type Signal } from "../reactive.js";
import { h, read, type Reactive } from "../dom.js";

export type MetricState = "ok" | "warn" | "bad" | "neutral";

export interface MetricOptions {
  label: string;
  value: Reactive<number | string>;
  unit?: string;
  /** Change since some earlier point. Positive is not assumed to be good. */
  delta?: Reactive<number | null>;
  /** Whether a rise is good. Reverses the colour, never the arrow. */
  deltaIsGood?: "up" | "down";
  state?: Reactive<MetricState>;
  note?: Reactive<string>;
  format?: (value: number | string) => string;
  /** The host's locale, from `hostContext.locale`.
   *
   * Not optional in practice. `Intl.NumberFormat()` with no locale uses the
   * one the browser happens to be set to, and engines disagree: the same
   * 1234567 renders as `1,234,567` in Chromium and `12,34,567` in WebKit on
   * the same machine. A number the reader cannot parse at a glance is the one
   * thing a metric must never be. */
  locale?: Reactive<string | undefined>;
  onActivate?: () => void;
}

export interface Metric {
  el: HTMLElement;
  /** What a screen reader is told, and what a summary can quote. */
  description: Signal<string>;
}

const formatWith = (locale: string | undefined) =>
  (value: number | string): string =>
    typeof value === "number"
      ? new Intl.NumberFormat(locale).format(value) : String(value);

export function metric(options: MetricOptions): Metric {
  const { label, unit, note, onActivate } = options;

  const locale = computed(() =>
    options.locale ? read(options.locale) : undefined);
  const format = computed(() => options.format ?? formatWith(locale()));

  const shown = computed(() => format()(read(options.value)));
  const delta = computed(() => (options.delta ? read(options.delta) : null));
  const state = computed<MetricState>(() =>
    options.state ? read(options.state) : "neutral");

  const deltaText = computed(() => {
    const d = delta();
    if (d === null || d === undefined || d === 0) return "";
    return `${d > 0 ? "+" : ""}${formatWith(locale())(d)}`;
  });

  // Direction and goodness are separate. An error count going up is a rise
  // and it is bad; colouring by sign alone gets that backwards half the time.
  const deltaTone = computed(() => {
    const d = delta();
    if (!d || !options.deltaIsGood) return "flat";
    const rising = d > 0;
    return rising === (options.deltaIsGood === "up") ? "good" : "bad";
  });

  const description = computed(() => {
    const parts = [`${label}, ${shown()}${unit ? ` ${unit}` : ""}`];
    if (deltaText()) parts.push(`change ${deltaText()}`);
    if (note && read(note)) parts.push(String(read(note)));
    return parts.join(", ");
  });

  const inner = [
    h("div", { class: "metric-label", text: label }),
    h("div", { class: "metric-value" },
      h("span", { class: "metric-number", text: shown }),
      unit ? h("span", { class: "metric-unit", text: ` ${unit}` }) : null),
    computed(() => deltaText())() !== "" || options.delta
      ? h("div", {
          class: computed(() => `metric-delta ${deltaTone()}`),
          text: deltaText(),
          hidden: computed(() => deltaText() === ""),
        })
      : null,
    note ? h("div", { class: "metric-note", text: note }) : null,
  ].filter(Boolean) as Node[];

  // Interactive only when there is something to do. A tile that looks
  // clickable and is not is worse than one that looks inert.
  const el = onActivate
    ? h("button", {
        type: "button",
        class: computed(() => `metric metric-${state()}`),
        "aria-label": description,
        onclick: onActivate,
      }, ...inner)
    : h("div", {
        class: computed(() => `metric metric-${state()}`),
        role: "group",
        "aria-label": description,
      }, ...inner);

  return { el, description };
}
