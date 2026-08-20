/** The host relationship itself.
 *
 * The fourth kind, and the one nothing else has. A Pane draws a shape, a
 * Widget answers to a person and an agent, a Layout arranges. A Surface is
 * about the fact that a view does not own the thing it is drawn in: the host
 * decides how wide it is, whether it is inline or fullscreen, which corners
 * are behind a notch, what locale the reader has, and when it stops existing.
 *
 * Everything here follows from one observation. A view that assumes it may do
 * something is a view that fails silently in front of a person the first time
 * it may not, and the failure looks like the app being broken rather than the
 * host saying no. So there is no boolean here anywhere:
 *
 *     granted  the host has the capability and did the thing
 *     absent   the host never offered the capability
 *     refused  the host has it, was asked, and said no
 *
 * `absent` and `refused` are different situations and a view usually wants to
 * handle them differently: absent means offer a fallback, refused means say
 * what happened. Collapsing them into `false` is how the export button in the
 * cookbook's harness came to do nothing at all, quietly, in front of a user.
 *
 * The teardown handshake is the other half. A host that is taking a view away
 * asks first, and a view that has something unsaved gets one chance to say so.
 */
import { computed, effect, signal, type Signal } from "./reactive.js";
import type { HostCalls, HostEvent } from "./bridge.js";

export type Outcome = "granted" | "absent" | "refused";

export interface Refusal {
  capability: string;
  /** Why, as the host put it. Empty when the host offered no reason. */
  reason: string;
  outcome: Exclude<Outcome, "granted">;
}

export type DisplayMode = "inline" | "fullscreen" | "pip";

export interface Insets {
  top: number; right: number; bottom: number; left: number;
}

/** What the host tells the view about the reader and the frame.
 *
 * Every field is optional because every field is the host's to withhold, and
 * a view that requires one of them does not run in the host that does not
 * send it. */
export interface HostContext {
  /** From the host, never from the engine. The default differs by engine. */
  locale?: string;
  theme?: "light" | "dark";
  displayMode?: DisplayMode;
  /** Space the host has spoken for: a notch, a home indicator, a toolbar. */
  safeArea?: Partial<Insets>;
  maxHeight?: number;
  [key: string]: unknown;
}

export interface SurfaceOptions {
  bridge: HostCalls;
  /** What the host said it can do, from `_meta` on the request that opened
   *  this view. Absent means absent: an empty object is a host that offers
   *  nothing, which is a real thing a host does. */
  capabilities?: Record<string, unknown>;
  context?: HostContext;
  /** The element the frame's own styling hangs off. Defaults to the document
   *  element, which is what a view normally wants. */
  root?: HTMLElement;
  /** Report the view's height to the host as it changes. On by default,
   *  because a host that is not told sizes the frame by guessing. */
  reportSize?: boolean;
}

export interface Surface {
  capabilities: Signal<Record<string, unknown>>;
  context: Signal<HostContext>;
  displayMode: Signal<DisplayMode>;
  locale: Signal<string | undefined>;
  theme: Signal<"light" | "dark" | undefined>;
  safeArea: Signal<Insets>;
  /** Every refusal and absence so far, in order. A view can show this. */
  refusals: Signal<readonly Refusal[]>;
  /** Whether the host offered a capability at all. */
  has(capability: string): boolean;
  /** Ask the host to do something. Never throws: it answers with which of the
   *  three situations happened. */
  request(capability: string, params?: unknown): Promise<Outcome>;
  /** The same, when the answer carries a value. */
  ask<T>(capability: string, params?: unknown): Promise<
    { outcome: "granted"; value: T } | { outcome: Exclude<Outcome, "granted">; reason: string }>;
  requestDisplayMode(mode: DisplayMode): Promise<Outcome>;
  sendSizeChanged(height?: number): void;
  openLink(url: string): Promise<Outcome>;
  downloadFile(file: { name: string; mimeType: string; contents: string }): Promise<Outcome>;
  sendMessage(text: string): Promise<Outcome>;
  updateModelContext(context: { text?: string; structuredContent?: unknown }): Promise<Outcome>;
  log(level: string, message: string): Promise<Outcome>;
  /** Runs before the host takes the view away. Return false to object, which
   *  a host may or may not honour: it is a request, not a veto. */
  onTeardown(handler: () => boolean | Promise<boolean>): () => void;
  /** Ask to be taken away, when the view is finished with itself. */
  requestTeardown(): Promise<Outcome>;
  /** Stop listening and reporting. */
  dispose(): void;
}

const INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

const reasonOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause ?? "");

export function surface(options: SurfaceOptions): Surface {
  const { bridge } = options;
  const capabilities = signal<Record<string, unknown>>(options.capabilities ?? {});
  const context = signal<HostContext>(options.context ?? {});
  const refusals = signal<readonly Refusal[]>([]);
  const teardownHandlers = new Set<() => boolean | Promise<boolean>>();
  const root = options.root
    ?? (typeof document === "undefined" ? undefined : document.documentElement);

  const displayMode = computed<DisplayMode>(() => context().displayMode ?? "inline");
  const locale = computed(() => context().locale);
  const theme = computed(() => context().theme);
  const safeArea = computed<Insets>(() => ({ ...INSETS, ...(context().safeArea ?? {}) }));

  const has = (capability: string): boolean =>
    Object.prototype.hasOwnProperty.call(capabilities(), capability);

  const note = (capability: string, outcome: Exclude<Outcome, "granted">, reason: string) => {
    refusals.update((previous) => [...previous, { capability, outcome, reason }]);
  };

  const ask = async <T>(capability: string, params?: unknown) => {
    if (!has(capability)) {
      // Never asked, because the host never offered. Asking anyway produces a
      // rejection that reads like a refusal, and the two want different
      // handling: absent takes a fallback, refused takes an explanation.
      note(capability, "absent", "");
      return { outcome: "absent" as const, reason: "" };
    }
    try {
      const value = await bridge.callHost(capability, params);
      return { outcome: "granted" as const, value: value as T };
    } catch (cause) {
      const reason = reasonOf(cause);
      note(capability, "refused", reason);
      return { outcome: "refused" as const, reason };
    }
  };

  const request = async (capability: string, params?: unknown): Promise<Outcome> =>
    (await ask(capability, params)).outcome;

  // The host talks without being asked: it resizes, it changes theme, it moves
  // the view between inline and fullscreen, and eventually it asks the view to
  // go away.
  const stop = bridge.onHost((event: HostEvent) => {
    if (event.type === "hostContext" || event.type === "context") {
      context.update((previous) => ({ ...previous, ...(event.data as HostContext) }));
      return;
    }
    if (event.type === "hostCapabilities" || event.type === "capabilities") {
      capabilities.set((event.data ?? {}) as Record<string, unknown>);
      return;
    }
    if (event.type === "displayMode") {
      context.update((previous) => ({
        ...previous, displayMode: (event.data as DisplayMode) ?? "inline",
      }));
      return;
    }
    if (event.type === "teardown") {
      void (async () => {
        // Every handler is asked, and one objection is enough. The host is not
        // obliged to listen, which is why this answers rather than blocks.
        let ready = true;
        for (const handler of [...teardownHandlers]) {
          try { if ((await handler()) === false) ready = false; }
          catch { ready = false; }
        }
        if (event.id) bridge.reply(event.id, { ready });
      })();
    }
  });

  // What the host said about the frame, put where CSS can reach it. A view
  // that ignores the insets draws its first row of controls under a notch.
  const applyContext = effect(() => {
    if (!root) return;
    const inset = safeArea();
    root.style.setProperty("--safe-area-top", `${inset.top}px`);
    root.style.setProperty("--safe-area-right", `${inset.right}px`);
    root.style.setProperty("--safe-area-bottom", `${inset.bottom}px`);
    root.style.setProperty("--safe-area-left", `${inset.left}px`);
    root.dataset.displayMode = displayMode();
    if (theme()) root.dataset.theme = theme()!;
  });

  let observer: ResizeObserver | null = null;
  const sendSizeChanged = (height?: number) => {
    const measured = height
      ?? (typeof document === "undefined" ? 0 : document.documentElement.scrollHeight);
    void ask("sendSizeChanged", { height: measured });
  };

  if (options.reportSize !== false && typeof ResizeObserver !== "undefined"
      && typeof document !== "undefined") {
    observer = new ResizeObserver(() => sendSizeChanged());
    observer.observe(document.documentElement);
  }

  return {
    capabilities, context, displayMode, locale, theme, safeArea, refusals,
    has, request, ask,
    requestDisplayMode: (mode) => request("requestDisplayMode", { mode }),
    sendSizeChanged,
    openLink: (url) => request("openLink", { url }),
    downloadFile: (file) => request("downloadFile", file),
    sendMessage: (text) => request("sendMessage", { text }),
    updateModelContext: (update) => request("updateModelContext", update),
    log: (level, message) => request("sendLog", { level, message }),
    onTeardown(handler) {
      teardownHandlers.add(handler);
      return () => teardownHandlers.delete(handler);
    },
    requestTeardown: () => request("requestTeardown"),
    dispose() {
      stop();
      applyContext();
      observer?.disconnect();
    },
  };
}
