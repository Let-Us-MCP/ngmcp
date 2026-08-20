/** A button that knows the host might not let it do the thing.
 *
 * Ordinary button libraries have one state. A button here has three, because
 * the operation behind it may need a host capability: granted, never offered,
 * or offered and then refused. The default failure in the wild is the third
 * one happening silently, which is a button that appears to work and does
 * nothing. That is the case this component exists to make impossible.
 */
import { computed, signal, type Signal } from "../reactive.js";
import { h, read, type Reactive } from "../dom.js";

export type ButtonVariant = "primary" | "default" | "quiet" | "danger";

export interface ButtonOptions {
  label: Reactive<string>;
  onActivate: () => void | Promise<void>;
  variant?: ButtonVariant;
  disabled?: Reactive<boolean>;
  /** Host capability the operation needs, e.g. "downloadFile". */
  requires?: string;
  /** What the host granted. Absent means nothing is known and all is allowed. */
  capabilities?: Reactive<Record<string, unknown> | undefined>;
  /** Shown instead of the label when the capability was never offered. */
  unavailableLabel?: Reactive<string>;
  /** Offered when the capability is missing, e.g. copy instead of download. */
  fallback?: { label: string; onActivate: () => void | Promise<void> };
  /** Announced when the operation is refused. */
  onError?: (error: Error) => void;
}

export interface Button {
  el: HTMLElement;
  /** granted, absent, refused, or busy while running. */
  state: Signal<"granted" | "absent" | "refused" | "busy">;
  /** Set when the last attempt was refused. */
  error: Signal<string>;
}

export function button(options: ButtonOptions): Button {
  const { requires, fallback, variant = "default" } = options;
  const error = signal("");
  const busy = signal(false);

  const available = computed(() => {
    if (!requires) return true;
    const caps = options.capabilities ? read(options.capabilities) : undefined;
    // Nothing known about the host means do not pre-emptively disable. A
    // capability map that exists and lacks the key means it was not offered.
    if (caps === undefined) return true;
    return Object.prototype.hasOwnProperty.call(caps, requires);
  });

  const state = computed<"granted" | "absent" | "refused" | "busy">(() =>
    busy() ? "busy" : error() ? "refused" : available() ? "granted" : "absent");

  const message = h("span", {
    class: "button-error",
    role: "status",
    text: error,
    hidden: computed(() => error() === ""),
  });

  async function activate(): Promise<void> {
    if (busy()) return;
    error.set("");
    busy.set(true);
    try {
      await options.onActivate();
    } catch (thrown) {
      // A refusal is reported where the reader is looking, not swallowed and
      // not only logged. This is the whole point of the component.
      const failure = thrown instanceof Error ? thrown : new Error(String(thrown));
      error.set(failure.message || "The host refused that.");
      options.onError?.(failure);
    } finally {
      busy.set(false);
    }
  }

  const main = h("button", {
    type: "button",
    class: computed(() => `btn btn-${variant} btn-${state()}`),
    disabled: computed(() =>
      busy() || (options.disabled ? read(options.disabled) : false)),
    "aria-busy": computed(() => (busy() ? "true" : "false")),
    "aria-describedby": computed(() => (error() ? "btn-error" : null)),
    text: computed(() =>
      available()
        ? read(options.label)
        : options.unavailableLabel
          ? read(options.unavailableLabel)
          : read(options.label)),
    onclick: activate,
  });

  message.id = "btn-error";

  const children: Node[] = [main];
  // When the capability was never offered, a fallback is a better answer than
  // a disabled control with no explanation.
  if (fallback) {
    children.push(h("button", {
      type: "button",
      class: "btn btn-quiet btn-fallback",
      text: fallback.label,
      hidden: computed(() => available()),
      onclick: () => void fallback.onActivate(),
    }));
  }
  children.push(message);

  return { el: h("span", { class: "btn-group" }, ...children), state, error };
}
