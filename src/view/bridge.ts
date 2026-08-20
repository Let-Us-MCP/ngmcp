/** Reaching the host from inside the frame.
 *
 * The frame has an opaque origin, so the only way out is `postMessage`. This
 * is the smallest correct implementation: a request carries an id, the reply
 * carries it back, and nothing assumes replies arrive in order.
 *
 * `@modelcontextprotocol/ext-apps` provides a fuller bridge and a host that
 * already speaks to it. Use that where it is available; this exists so a view
 * can be built and tested without one, and so the shape of what a host must
 * provide is written down somewhere.
 */
import type { Bridge } from "./client.js";

/** A message the host sends without being asked.
 *
 * The view is not only a caller: the host resizes it, moves it between inline
 * and fullscreen, changes theme and locale under it, and eventually asks it to
 * go away. Those arrive unprompted, which is why they are a separate shape
 * from a reply and why a reply id is optional on them. `teardown` is the one
 * that carries an id, because the host is waiting for an answer. */
export interface HostEvent {
  type: string;
  data?: unknown;
  /** Present when the host expects the view to answer. */
  id?: string;
}

/** What a view can do to a host, beyond calling its tools. */
export interface HostCalls {
  /** Call a host method. Rejects when the host refuses, with its reason. */
  callHost(method: string, params?: unknown): Promise<unknown>;
  /** Listen for what the host says on its own. Returns an unsubscriber. */
  onHost(handler: (event: HostEvent) => void): () => void;
  /** Answer a host request that carried an id. */
  reply(id: string, result: unknown): void;
}

export interface HostBridgeOptions {
  /** Where to post. Defaults to the frame's parent. */
  target?: { postMessage(message: unknown, origin: string): void };
  /** Abandon a call after this long. Zero waits forever. */
  timeoutMs?: number;
}

interface Pending {
  resolve: (value: never) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export function hostBridge(options: HostBridgeOptions = {}): Bridge & HostCalls {
  const target = options.target ?? (globalThis as { parent?: Window }).parent;
  const timeoutMs = options.timeoutMs ?? 30000;
  const pending = new Map<string, Pending>();
  const listeners = new Set<(event: HostEvent) => void>();
  let counter = 0;

  addEventListener("message", (event: MessageEvent) => {
    const data = event.data as {
      __id?: string; result?: unknown; error?: string;
      __event?: string; data?: unknown;
    };
    if (!data) return;
    if (typeof data.__event === "string") {
      const received: HostEvent = { type: data.__event };
      if (data.data !== undefined) received.data = data.data;
      if (typeof data.__id === "string") received.id = data.__id;
      for (const listener of [...listeners]) listener(received);
      return;
    }
    if (typeof data.__id !== "string") return;
    const waiter = pending.get(data.__id);
    if (!waiter) return;
    pending.delete(data.__id);
    if (waiter.timer) clearTimeout(waiter.timer);
    if (data.error) waiter.reject(new Error(data.error));
    else waiter.resolve(data.result as never);
  });

  const send = (
    message: Record<string, unknown>, id: string, what: string,
  ): Promise<unknown> => new Promise((resolve, reject) => {
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          pending.delete(id);
          reject(new Error(`The host did not answer ${what} in ${timeoutMs}ms.`));
        }, timeoutMs)
      : null;
    pending.set(id, { resolve: resolve as (v: never) => void, reject, timer });
    if (!target) {
      pending.delete(id);
      if (timer) clearTimeout(timer);
      reject(new Error("This view has no host to talk to."));
      return;
    }
    target.postMessage({ ...message, __id: id }, "*");
  });

  return {
    callServerTool(name, args) {
      return send({ __call: name, args }, `c${++counter}`, name) as Promise<never>;
    },
    callHost(method, params) {
      return send({ __host: method, params }, `h${++counter}`, method);
    },
    onHost(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    reply(id, result) {
      target?.postMessage({ __id: id, result }, "*");
    },
  };
}
