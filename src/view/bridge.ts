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

export function hostBridge(options: HostBridgeOptions = {}): Bridge {
  const target = options.target ?? (globalThis as { parent?: Window }).parent;
  const timeoutMs = options.timeoutMs ?? 30000;
  const pending = new Map<string, Pending>();
  let counter = 0;

  addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { __id?: string; result?: unknown; error?: string };
    if (!data || typeof data.__id !== "string") return;
    const waiter = pending.get(data.__id);
    if (!waiter) return;
    pending.delete(data.__id);
    if (waiter.timer) clearTimeout(waiter.timer);
    if (data.error) waiter.reject(new Error(data.error));
    else waiter.resolve(data.result as never);
  });

  return {
    callServerTool(name, args) {
      return new Promise((resolve, reject) => {
        const id = `c${++counter}`;
        const timer = timeoutMs > 0
          ? setTimeout(() => {
              pending.delete(id);
              reject(new Error(`The host did not answer ${name} in ${timeoutMs}ms.`));
            }, timeoutMs)
          : null;
        pending.set(id, { resolve: resolve as (v: never) => void, reject, timer });
        if (!target) {
          reject(new Error("This view has no host to talk to."));
          return;
        }
        target.postMessage({ __call: name, __id: id, args }, "*");
      });
    },
  };
}
