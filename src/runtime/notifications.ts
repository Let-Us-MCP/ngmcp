import type { Notification, Id } from "../protocol/jsonrpc.js";
import { META } from "../protocol/version.js";
import type { RequestLifetime } from "./concurrency.js";

export type Sink = (message: Notification) => void;

/** How full the transport may get before advisory traffic is thinned. */
export interface Backpressure {
  /** Pending bytes above which progress notifications coalesce. */
  highWaterMark: number;
  /** Reports what the transport is still holding. */
  pending(): number;
}

/** Notifications that belong to one request, and die with it.
 *
 * Two rules the specification states and most implementations get wrong.
 * Progress may only reference a token the client supplied on a request that is
 * still running, and `notifications/message` may not be emitted at all unless
 * that request asked for logging. Both are enforced here rather than left to
 * the handler, because a handler that gets it wrong produces traffic the
 * client cannot attribute to anything.
 */
export class RequestNotifier {
  #dropped = 0;
  #lastProgress: Notification | null = null;
  #flushQueued = false;

  constructor(
    private readonly sink: Sink,
    private readonly lifetime: RequestLifetime,
    private readonly progressToken: string | number | undefined,
    private readonly logLevel: string | undefined,
    private readonly backpressure?: Backpressure,
  ) {}

  /** Progress notifications dropped to keep the transport from growing. */
  get dropped(): number { return this.#dropped; }

  /** True when nothing may be sent: the response is out, or the request died. */
  get closed(): boolean {
    return this.lifetime.settled || this.lifetime.aborted;
  }

  progress(progress: number, total?: number, message?: string): void {
    // No token means the client did not opt in. Sending anyway invents a
    // correlation the client never asked for.
    if (this.progressToken === undefined || this.closed) return;
    const note: Notification = {
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: {
        progressToken: this.progressToken,
        progress,
        ...(total !== undefined ? { total } : {}),
        ...(message !== undefined ? { message } : {}),
      },
    };
    // Progress is advisory, so under pressure the newest one replaces the
    // backlog rather than joining it. A response is never treated this way.
    if (this.backpressure &&
        this.backpressure.pending() > this.backpressure.highWaterMark) {
      if (this.#lastProgress) this.#dropped += 1;
      this.#lastProgress = note;
      this.#queueFlush();
      return;
    }
    this.sink(note);
  }

  log(level: string, data: unknown, logger?: string): void {
    // Request-scoped: a request that did not set a log level gets no logs.
    if (this.logLevel === undefined || this.closed) return;
    this.sink({
      jsonrpc: "2.0",
      method: "notifications/message",
      params: {
        level,
        ...(logger !== undefined ? { logger } : {}),
        data,
        _meta: { [META.logLevel]: this.logLevel },
      },
    });
  }

  #queueFlush(): void {
    if (this.#flushQueued) return;
    this.#flushQueued = true;
    queueMicrotask(() => {
      this.#flushQueued = false;
      const note = this.#lastProgress;
      this.#lastProgress = null;
      if (!note || this.closed) return;
      if (this.backpressure &&
          this.backpressure.pending() > this.backpressure.highWaterMark) {
        this.#lastProgress = note;
        this.#queueFlush();
        return;
      }
      this.sink(note);
    });
  }
}

/** Tracks which request ids are in flight so cancellation can find them. */
export class InFlight {
  readonly #map = new Map<Id, RequestLifetime>();

  add(id: Id, lifetime: RequestLifetime): void { this.#map.set(id, lifetime); }
  remove(id: Id): void { this.#map.delete(id); }
  get size(): number { return this.#map.size; }
  has(id: Id): boolean { return this.#map.has(id); }

  cancel(id: Id): boolean {
    const lifetime = this.#map.get(id);
    if (!lifetime) return false;
    lifetime.abort("cancelled");
    return true;
  }

  cancelAll(reason: "closed" | "cancelled" = "closed"): void {
    for (const lifetime of this.#map.values()) lifetime.abort(reason);
    this.#map.clear();
  }
}
