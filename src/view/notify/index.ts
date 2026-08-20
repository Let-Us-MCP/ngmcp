/** Saying something to the reader without stealing their place.
 *
 * The rule that shaped this: a live region that announces every event is
 * unusable the moment events arrive quickly. A log at five lines a second
 * read aloud is noise. So the region is polite, messages are coalesced, and
 * a burst becomes one summary rather than twenty interruptions.
 */
import { computed, signal, type Signal } from "../reactive.js";
import { h } from "../dom.js";

export type Severity = "info" | "success" | "warning" | "error";

export interface ToastOptions {
  /** How long a toast stays. Zero keeps it until dismissed. */
  timeoutMs?: number;
  /** Announcements inside this window become one summary. */
  coalesceMs?: number;
  max?: number;
}

export interface Toaster {
  el: HTMLElement;
  show(message: string, severity?: Severity): void;
  /** Announce without showing anything, for things already visible. */
  announce(message: string): void;
  count: Signal<number>;
  clear(): void;
}

export function toaster(options: ToastOptions = {}): Toaster {
  const { timeoutMs = 5000, coalesceMs = 1000, max = 4 } = options;
  const list = h("div", { class: "toasts", role: "presentation" });
  // Off, not polite: each toast is announced through the region below on a
  // schedule this controls, rather than by the region noticing a DOM change.
  const region = h("div", {
    class: "sr-only", role: "status", "aria-live": "polite", "aria-atomic": "true",
  });
  const el = h("div", { class: "toaster" }, list, region);
  const count = signal(0);

  let queued: string[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    const messages = queued;
    queued = [];
    if (!messages.length) return;
    region.textContent = messages.length === 1
      ? messages[0] as string
      : `${messages.length} notifications, latest: ${messages[messages.length - 1]}`;
  };

  const announce = (message: string) => {
    queued.push(message);
    if (timer) return;
    timer = setTimeout(flush, coalesceMs);
  };

  const show = (message: string, severity: Severity = "info") => {
    const node = h("div", {
      class: `toast toast-${severity}`,
      // The visible toast is not itself a live region; announcing happens
      // once, on a schedule, through the region above.
      role: "presentation",
    },
      h("span", { class: "toast-text", text: message }),
      h("button", {
        type: "button", class: "toast-close", "aria-label": "Dismiss",
        onclick: () => remove(node),
      }));
    list.appendChild(node);
    count.set(list.children.length);
    while (list.children.length > max) remove(list.firstElementChild as HTMLElement);
    if (timeoutMs > 0) setTimeout(() => remove(node), timeoutMs);
    announce(message);
  };

  function remove(node: Element | null): void {
    if (!node || !node.parentNode) return;
    node.parentNode.removeChild(node);
    count.set(list.children.length);
  }

  return {
    el, show, announce, count,
    clear() { list.replaceChildren(); count.set(0); },
  };
}

export interface BannerOptions {
  severity?: Severity;
  message: string;
  /** Shown as a button beside the message. */
  action?: { label: string; onActivate: () => void };
  dismissible?: boolean;
  onDismiss?: () => void;
}

export interface Banner {
  el: HTMLElement;
  show(message?: string, severity?: Severity): void;
  hide(): void;
  visible: Signal<boolean>;
}

/** A message that stays until the thing it describes is no longer true.
 *
 * Distinct from a toast on purpose: a toast is an event that has passed, a
 * banner is a condition that persists. Conditions must not disappear on a
 * timer while still being the case.
 */
export function banner(options: BannerOptions): Banner {
  const visible = signal(false);
  const text = signal(options.message);
  const severity = signal<Severity>(options.severity ?? "info");

  const label = h("span", { class: "banner-text", text });
  const children: Node[] = [label];
  if (options.action) {
    children.push(h("button", {
      type: "button", class: "banner-action",
      text: options.action.label, onclick: options.action.onActivate,
    }));
  }
  if (options.dismissible) {
    children.push(h("button", {
      type: "button", class: "banner-close", "aria-label": "Dismiss",
      onclick: () => { visible.set(false); options.onDismiss?.(); },
    }));
  }

  const el = h("div", {
    class: computed(() => `banner banner-${severity()}`),
    role: "status",
    hidden: computed(() => !visible()),
  }, ...children);

  return {
    el, visible,
    show(message, next) {
      if (message !== undefined) text.set(message);
      if (next !== undefined) severity.set(next);
      visible.set(true);
    },
    hide() { visible.set(false); },
  };
}
