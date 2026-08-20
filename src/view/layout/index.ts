/** Arrangement, and nothing else.
 *
 * A Layout in Panel's sense holds no data. What is different here is that it
 * answers to the host: the frame is resized by somebody else, it switches
 * between inline and fullscreen without asking, and on a phone it may be
 * three hundred pixels wide. A layout that assumes its own width is a layout
 * that breaks in half the places it runs.
 */
import { computed, effect, signal, type Signal } from "../reactive.js";
import { h, read, type Child, type Reactive } from "../dom.js";

export type Gap = "none" | "tight" | "normal" | "loose";
export type Align = "start" | "center" | "end" | "stretch";

export interface StackOptions {
  gap?: Gap;
  align?: Align;
  /** Scrolls internally rather than growing the frame. */
  scroll?: boolean;
}

/** Vertical flow. The default arrangement for anything read top to bottom. */
export function stack(options: StackOptions = {}, ...children: Child[]): HTMLElement {
  const { gap = "normal", align = "stretch", scroll = false } = options;
  return h("div", {
    class: `stack gap-${gap} align-${align}${scroll ? " scroll" : ""}`,
  }, ...children);
}

/** Horizontal flow that wraps rather than overflowing. */
export function row(options: StackOptions = {}, ...children: Child[]): HTMLElement {
  const { gap = "normal", align = "center" } = options;
  return h("div", { class: `row gap-${gap} align-${align}` }, ...children);
}

/** Pushes what follows it to the far edge. */
export const spacer = (): HTMLElement => h("span", { class: "spacer" });

export const divider = (label?: string): HTMLElement =>
  label
    ? h("div", { class: "divider labelled", role: "separator", "aria-label": label },
        h("span", { text: label }))
    : h("hr", { class: "divider" });

export interface ColumnsOptions {
  /** Relative widths. `[2, 1]` gives the first column twice the second. */
  weights?: number[];
  gap?: Gap;
  /** Below this width the columns stack. Hosts do hand out 320 pixels. */
  collapseBelow?: number;
}

/** Side by side, until there is no room to be side by side.
 *
 * Uses a container query rather than a media query, because the frame's width
 * is not the viewport's and the host changes it without telling anyone.
 */
export function columns(options: ColumnsOptions = {}, ...children: Child[]): HTMLElement {
  const { weights, gap = "normal", collapseBelow = 480 } = options;
  const el = h("div", {
    class: `columns gap-${gap}`,
    "data-collapse-below": String(collapseBelow),
    style: {
      gridTemplateColumns: weights
        ? weights.map((w) => `${w}fr`).join(" ")
        : `repeat(${Math.max(1, children.flat(Infinity as 1).filter(Boolean).length)}, 1fr)`,
    },
  }, ...children);

  // A ResizeObserver rather than a media query: the frame is not the viewport.
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      el.classList.toggle("collapsed", entry.contentRect.width < collapseBelow);
    });
    observer.observe(el);
  }
  return el;
}

export interface CardOptions {
  title?: Reactive<string>;
  /** Placed at the top right, for the operations that belong to this card. */
  actions?: Child[];
  footer?: Child;
  /** Announced as a region with this name, for a dashboard of many cards. */
  label?: string;
}

export function card(options: CardOptions = {}, ...children: Child[]): HTMLElement {
  const { title, actions, footer, label } = options;
  const head = title || actions?.length
    ? h("div", { class: "card-head" },
        title ? h("h2", { class: "card-title", text: title }) : null,
        actions?.length ? h("div", { class: "card-actions" }, ...actions) : null)
    : null;
  return h("section", {
    class: "card",
    ...(label || title ? { "aria-label": label ?? (typeof title === "string" ? title : undefined) } : {}),
  },
    head,
    h("div", { class: "card-body" }, ...children),
    footer ? h("div", { class: "card-foot" }, footer) : null);
}

export interface Tab {
  id: string;
  label: string;
  /** Built when the tab is first shown, so hidden panels cost nothing. */
  content: () => Child;
}

export interface TabsOptions {
  tabs: Tab[];
  active?: string;
  label?: string;
  onChange?: (id: string) => void;
}

export interface Tabs {
  el: HTMLElement;
  active: Signal<string>;
  select(id: string): void;
}

/** A tab list, following the ARIA practice rather than approximating it.
 *
 * The keyboard contract is the part people leave out: arrows move between
 * tabs, Home and End jump to the ends, and only the selected tab is in the
 * tab order so that Tab moves out of the list rather than through it.
 */
export function tabs(options: TabsOptions): Tabs {
  const { tabs: items, label = "Tabs", onChange } = options;
  const active = signal(options.active ?? items[0]?.id ?? "");
  const built = new Map<string, Node>();

  const select = (id: string): void => {
    if (!items.some((t) => t.id === id) || active.peek() === id) return;
    active.set(id);
    onChange?.(id);
    tabButtons.get(id)?.focus();
  };

  const move = (from: string, delta: number): void => {
    const index = items.findIndex((t) => t.id === from);
    const next = items[(index + delta + items.length) % items.length];
    if (next) select(next.id);
  };

  const tabButtons = new Map<string, HTMLElement>();
  const list = h("div", { class: "tablist", role: "tablist", "aria-label": label });

  for (const item of items) {
    const selected = computed(() => active() === item.id);
    const btn = h("button", {
      type: "button",
      class: computed(() => `tab${selected() ? " selected" : ""}`),
      role: "tab",
      id: `tab-${item.id}`,
      "aria-selected": computed(() => String(selected())),
      "aria-controls": `panel-${item.id}`,
      // Only the selected tab is reachable with Tab; the rest with arrows.
      tabindex: computed(() => (selected() ? "0" : "-1")),
      text: item.label,
      onclick: () => select(item.id),
      onkeydown: (event: KeyboardEvent) => {
        const key = event.key;
        if (key === "ArrowRight") { event.preventDefault(); move(item.id, 1); }
        else if (key === "ArrowLeft") { event.preventDefault(); move(item.id, -1); }
        else if (key === "Home") { event.preventDefault(); select(items[0]!.id); }
        else if (key === "End") { event.preventDefault(); select(items[items.length - 1]!.id); }
      },
    });
    tabButtons.set(item.id, btn);
    list.appendChild(btn);
  }

  const panels = h("div", { class: "tabpanels" });
  for (const item of items) {
    const panel = h("div", {
      class: "tabpanel",
      role: "tabpanel",
      id: `panel-${item.id}`,
      "aria-labelledby": `tab-${item.id}`,
      tabindex: "0",
      hidden: computed(() => active() !== item.id),
    });
    panels.appendChild(panel);
    // Built once, the first time it is shown, so hidden panels cost nothing
    // and a dashboard with six tabs does not fetch six times on open.
    effect(() => {
      if (active() !== item.id || built.has(item.id)) return;
      built.set(item.id, panel);
      const content = item.content();
      for (const node of ([] as Child[]).concat(content).flat(Infinity as 1)) {
        if (node === null || node === undefined || node === false) continue;
        panel.appendChild(node instanceof Node ? node : document.createTextNode(String(node)));
      }
    });
  }

  return { el: h("div", { class: "tabs" }, list, panels), active, select };
}

export interface DialogOptions {
  title: string;
  /** Nothing but the dialog is reachable while it is open. */
  content: Child;
  actions?: Child[];
  /** Escape and the backdrop both close it unless this is false. */
  dismissible?: boolean;
  onClose?: (reason: "escape" | "backdrop" | "action") => void;
}

export interface Dialog {
  el: HTMLDialogElement;
  open(): void;
  close(reason?: "escape" | "backdrop" | "action"): void;
  isOpen: Signal<boolean>;
}

/** A modal built on the platform's own dialog.
 *
 * `showModal` works inside the MCP Apps sandbox in both engines, which was
 * worth checking: `allow-modals` governs `alert` and `confirm`, not this. The
 * platform then supplies the focus trap, the top layer and Escape, all of
 * which are tedious and easy to get subtly wrong by hand.
 *
 * It also returns focus to whatever opened it when closed, which was worth
 * checking rather than assuming: a hand-written restore was in here until a
 * mutation test showed that removing it changed nothing in either engine.
 * Code that duplicates a platform guarantee is not a safety net, it is a
 * second thing to keep correct.
 */
export function dialog(options: DialogOptions): Dialog {
  const { title, dismissible = true } = options;
  const isOpen = signal(false);

  const el = h("dialog", {
    class: "dialog",
    "aria-labelledby": "dialog-title",
    onclose: () => { isOpen.set(false); },
    oncancel: (event: Event) => {
      if (!dismissible) { event.preventDefault(); return; }
      options.onClose?.("escape");
    },
    onclick: (event: MouseEvent) => {
      if (!dismissible || event.target !== el) return;
      options.onClose?.("backdrop");
      el.close();
    },
  },
    h("h2", { class: "dialog-title", id: "dialog-title", text: title }),
    h("div", { class: "dialog-body" }, options.content),
    options.actions?.length
      ? h("div", { class: "dialog-actions" }, ...options.actions) : null,
  ) as HTMLDialogElement;

  return {
    el, isOpen,
    open() {
      if (isOpen.peek()) return;
      if (!el.isConnected) document.body.appendChild(el);
      el.showModal();
      isOpen.set(true);
    },
    close(reason = "action") {
      if (!isOpen.peek()) return;
      options.onClose?.(reason);
      el.close();
    },
  };
}
