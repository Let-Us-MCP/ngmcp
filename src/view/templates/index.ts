/** Dashboard shells: the part that turns components into a dashboard.
 *
 * A page is one structured response drawn well. A dashboard is many of them,
 * composed, persisting across turns, and it changes what the shell has to do
 * rather than only how it looks. Four obligations, none of which a widget set
 * has to meet:
 *
 * - **Many tools feeding many panels.** Each panel loads itself and reports
 *   its own state, so a board of six panels is six independent answers rather
 *   than one big one that fails as a unit.
 * - **Refresh without re-fetching the board.** `panel.refresh()` calls that
 *   panel's loader and nothing else. A dashboard where one stale number costs
 *   a full reload is a page with a spinner.
 * - **Layout as state.** Which panels, where, at what size. The protocol has
 *   no sessions, so this is not kept for the caller anywhere: `layout()` hands
 *   out a plain value the view passes to a tool as an ordinary argument, and
 *   the server mints a handle for it. That is the whole of the answer to
 *   persistence in a stateless protocol, and it is deliberately the caller's
 *   job to carry it.
 * - **One column at 320 pixels.** Hosts do hand out 320 pixels, and they do it
 *   by resizing the frame rather than by telling anyone. Measured with a
 *   `ResizeObserver` on the shell itself, never a media query.
 *
 * Dragging is a pointer convenience. Moving and resizing are keyboard
 * operations first, because a board a person cannot rearrange without a mouse
 * is a board they cannot rearrange.
 */
import { computed, effect, signal, type Signal } from "../reactive.js";
import { h, uid, type Child, type Reactive } from "../dom.js";

export interface ListTemplateOptions {
  /** Named in the header and used as the document's own heading. */
  title: Reactive<string>;
  /** Beside the title: the operations that belong to the whole board. */
  actions?: Child[];
  sidebar?: Child;
  /** What the sidebar is called, since a nameless region helps nobody. */
  sidebarLabel?: string;
  footer?: Child;
  /** Below this width the sidebar stops being a column. */
  collapseBelow?: number;
}

export interface ListTemplate {
  el: HTMLElement;
  /** Whether the shell is currently in its one-column form. */
  narrow: Signal<boolean>;
}

/** Header, sidebar, main. The shape most dashboards already are.
 *
 * The sidebar is a `<nav>` and the body is a `<main>`, so the reader gets the
 * landmarks a page normally has. A view is a document, even when it is 320
 * pixels wide inside somebody else's product.
 */
export function listTemplate(
  options: ListTemplateOptions, ...children: Child[]
): ListTemplate {
  const { title, actions, sidebar, footer, sidebarLabel = "Sections" } = options;
  const collapseBelow = options.collapseBelow ?? 640;
  const narrow = signal(false);
  const titleId = uid("shell-title");

  const el = h("div", {
    class: computed(() => `shell${narrow() ? " shell-narrow" : ""}`),
    "data-collapse-below": String(collapseBelow),
  },
    h("header", { class: "shell-header" },
      h("h1", { class: "shell-title", id: titleId, text: title }),
      actions?.length ? h("div", { class: "shell-actions" }, ...actions) : null),
    h("div", { class: "shell-body" },
      sidebar
        ? h("nav", { class: "shell-sidebar", "aria-label": sidebarLabel }, sidebar)
        : null,
      h("main", { class: "shell-main", "aria-labelledby": titleId }, ...children)),
    footer ? h("footer", { class: "shell-footer" }, footer) : null);

  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      narrow.set(entry.contentRect.width < collapseBelow);
    });
    observer.observe(el);
  }

  return { el, narrow };
}

export type PanelState = "idle" | "loading" | "ready" | "failed";

export interface PanelPlacement {
  /** Column the panel starts in, counting from zero. */
  x: number;
  /** Row the panel starts in, counting from zero. */
  y: number;
  /** Columns wide. */
  w: number;
  /** Rows tall. */
  h: number;
}

export interface PanelDefinition extends Partial<PanelPlacement> {
  id: string;
  title: string;
  /** Loads this panel and nothing else. Called on mount and on refresh. */
  load?: () => Promise<Child> | Child;
  /** Drawn when there is no loader, or before the first load returns. */
  content?: Child;
}

export interface Panel {
  id: string;
  el: HTMLElement;
  state: Signal<PanelState>;
  /** Re-runs this panel's loader. Nothing else on the board is touched. */
  refresh(): Promise<void>;
  place: Signal<PanelPlacement>;
}

/** What a layout is, once it leaves the view.
 *
 * A plain value on purpose. It goes to a tool as an argument, the server mints
 * a handle for it, and the handle comes back as an argument next time. No
 * session holds it, because there is no session to hold it. */
export interface Layout {
  columns: number;
  panels: Array<PanelPlacement & { id: string }>;
}

export interface GridStackOptions {
  panels: readonly PanelDefinition[];
  /** Columns at full width. One, below `collapseBelow`. */
  columns?: number;
  collapseBelow?: number;
  /** Called whenever a panel is moved or resized, with the whole layout.
   *
   * The whole layout rather than the delta, because what gets persisted is a
   * layout: handing back a move leaves the caller to reconstruct the thing
   * they are about to send anyway. */
  onLayoutChange?: (layout: Layout) => void;
  /** Named for the reader, since a board is a region worth naming. */
  label?: string;
}

export interface GridStack {
  el: HTMLElement;
  panels: readonly Panel[];
  /** The current layout, ready to be passed to a tool as an argument. */
  layout(): Layout;
  /** Put a layout back, from a handle the server minted earlier. */
  apply(layout: Layout): void;
  /** Reload one panel by id. */
  refresh(id: string): Promise<void>;
  /** Reload every panel, concurrently, each reporting its own state. */
  refreshAll(): Promise<void>;
  narrow: Signal<boolean>;
}

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

/** Panels on a grid, movable and resizable, with the layout as a value.
 *
 * Every operation has a keyboard route: the panel itself is a tab stop, arrows
 * move it, shift with arrows resizes it, and the result is announced. Dragging
 * exists as well and is the convenience rather than the mechanism.
 */
export function gridStack(options: GridStackOptions): GridStack {
  const columnCount = Math.max(1, options.columns ?? 12);
  const collapseBelow = options.collapseBelow ?? 640;
  const narrow = signal(false);
  const boardId = uid("board");

  const announcement = signal("");
  const live = h("p", {
    class: "sr-only", role: "status", "aria-live": "polite", text: announcement,
  });

  const panels: Panel[] = options.panels.map((definition, index) => {
    const place = signal<PanelPlacement>({
      x: definition.x ?? (index * 4) % columnCount,
      y: definition.y ?? Math.floor((index * 4) / columnCount),
      w: definition.w ?? 4,
      h: definition.h ?? 1,
    }, (a, b) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

    const state = signal<PanelState>(definition.load ? "idle" : "ready");
    const error = signal("");
    const body = h("div", { class: "panel-body" });
    const panelTitleId = `${boardId}-${definition.id}-title`;

    if (definition.content) body.append(...toNodes(definition.content));

    const refresh = async (): Promise<void> => {
      if (!definition.load) return;
      state.set("loading");
      error.set("");
      try {
        const content = await definition.load();
        body.replaceChildren(...toNodes(content));
        state.set("ready");
      } catch (cause) {
        // The panel says so and the board carries on. One tool that failed is
        // one panel that failed, which is the point of loading them apart.
        error.set(cause instanceof Error ? cause.message : String(cause));
        state.set("failed");
      }
    };

    const move = (dx: number, dy: number) => {
      place.update((p) => ({
        ...p,
        x: clamp(p.x + dx, 0, columnCount - p.w),
        y: Math.max(0, p.y + dy),
      }));
      say(definition.title, place());
    };

    const resize = (dw: number, dh: number) => {
      place.update((p) => ({
        ...p,
        w: clamp(p.w + dw, 1, columnCount - p.x),
        h: Math.max(1, p.h + dh),
      }));
      say(definition.title, place());
    };

    const say = (name: string, p: PanelPlacement) => {
      announcement.set(
        `${name}, column ${p.x + 1}, row ${p.y + 1}, ${p.w} wide, ${p.h} tall`);
      options.onLayoutChange?.(layout());
    };

    const el = h("section", {
      class: computed(() => `panel panel-${state()}`),
      id: `${boardId}-${definition.id}`,
      "aria-labelledby": panelTitleId,
      "aria-busy": computed(() => (state() === "loading" ? "true" : "false")),
      tabindex: "0",
      draggable: "true",
      onkeydown: (event: KeyboardEvent) => {
        const key = event.key;
        const step = event.shiftKey ? "resize" : "move";
        const by: Record<string, [number, number]> = {
          ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
        };
        const delta = by[key];
        if (!delta) return;
        event.preventDefault();
        if (step === "resize") resize(delta[0], delta[1]);
        else move(delta[0], delta[1]);
      },
      ondragstart: (event: DragEvent) => {
        event.dataTransfer?.setData("text/plain", definition.id);
      },
      ondragover: (event: DragEvent) => { event.preventDefault(); },
      ondrop: (event: DragEvent) => {
        event.preventDefault();
        const moved = event.dataTransfer?.getData("text/plain");
        if (!moved || moved === definition.id) return;
        swap(moved, definition.id);
      },
    },
      h("div", { class: "panel-head" },
        h("h2", { class: "panel-title", id: panelTitleId, text: definition.title }),
        h("button", {
          type: "button", class: "panel-refresh",
          "aria-label": `Refresh ${definition.title}`,
          hidden: !definition.load,
          disabled: computed(() => state() === "loading"),
          text: "Refresh",
          onclick: () => void refresh(),
        })),
      h("p", {
        class: "panel-error", role: "status",
        text: error, hidden: computed(() => state() !== "failed"),
      }),
      body);

    // Placement is set on the element rather than passed as a prop: `h` takes
    // a style object once, and this one has to change every time the panel
    // moves. A stringified object in a `style` attribute draws nothing.
    effect(() => {
      const p = place();
      if (narrow()) {
        el.style.gridColumn = "1 / -1";
        el.style.gridRow = "auto";
      } else {
        el.style.gridColumn = `${p.x + 1} / span ${p.w}`;
        el.style.gridRow = `${p.y + 1} / span ${p.h}`;
      }
    });

    return { id: definition.id, el, state, refresh, place };
  });

  const byId = new Map(panels.map((p) => [p.id, p]));

  const swap = (a: string, b: string) => {
    const one = byId.get(a), two = byId.get(b);
    if (!one || !two) return;
    const first = one.place();
    one.place.set(two.place());
    two.place.set(first);
    announcement.set(`Panels swapped.`);
    options.onLayoutChange?.(layout());
  };

  const layout = (): Layout => ({
    columns: columnCount,
    panels: panels.map((p) => ({ id: p.id, ...p.place() })),
  });

  const el = h("div", {
    class: computed(() => `board${narrow() ? " board-narrow" : ""}`),
    role: "group",
    "aria-label": options.label ?? "Dashboard panels",
    "data-collapse-below": String(collapseBelow),
    style: { display: "grid", gridTemplateColumns: `repeat(${columnCount}, 1fr)` },
  }, ...panels.map((p) => p.el), live);

  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      narrow.set(entry.contentRect.width < collapseBelow);
    });
    observer.observe(el);
  }

  // One column when there is no room for more, and the panels keep their
  // places so widening puts the board back the way it was.
  effect(() => {
    el.style.gridTemplateColumns = narrow()
      ? "1fr" : `repeat(${columnCount}, 1fr)`;
  });

  for (const panel of panels) void panel.refresh();

  return {
    el,
    panels,
    layout,
    apply(next: Layout) {
      for (const placed of next.panels) {
        const panel = byId.get(placed.id);
        // A layout that names a panel this board does not have is a layout
        // from an older version of the board, which is a normal thing to be
        // handed and not a reason to throw away the rest of it.
        if (!panel) continue;
        panel.place.set({ x: placed.x, y: placed.y, w: placed.w, h: placed.h });
      }
    },
    async refresh(id: string) { await byId.get(id)?.refresh(); },
    async refreshAll() { await Promise.all(panels.map((p) => p.refresh())); },
    narrow,
  };
}

function toNodes(child: Child): Node[] {
  const out: Node[] = [];
  const walk = (value: Child) => {
    if (value === null || value === undefined || value === false) return;
    if (Array.isArray(value)) { value.forEach(walk); return; }
    out.push(value instanceof Node ? value : document.createTextNode(String(value)));
  };
  walk(child);
  return out;
}

