/** Scheduling, not locking.
 *
 * Because `2026-07-28` requests carry their own context, two requests share
 * nothing and can run at once without coordination. What is left is deciding
 * how many run, how long they may take, and how they stop. That is all this
 * file does, and it is deliberately the only place in the runtime that knows
 * about time.
 */

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The real clock. Tests substitute a virtual one so the suite stays fast. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as never),
};

/** Runs at most `limit` tasks at once. Zero or less means no limit. */
export class Limiter {
  #active = 0;
  #queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  get active(): number { return this.#active; }
  get queued(): number { return this.#queue.length; }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.limit > 0 && this.#active >= this.limit) {
      await new Promise<void>((resolve) => this.#queue.push(resolve));
    }
    this.#active += 1;
    try {
      return await task();
    } finally {
      this.#active -= 1;
      const next = this.#queue.shift();
      if (next) next();
    }
  }
}

export class TimeoutError extends Error {
  constructor(readonly ms: number) {
    super(`Timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/** One request's lifetime: cancelled by the client, by timeout, or by exit.
 *
 * Nothing is killed on your behalf. The signal is forwarded so the work that
 * matters can stop; a handler that ignores it keeps running until it settles,
 * and its late result is discarded rather than written.
 */
export class RequestLifetime {
  readonly controller = new AbortController();
  #timer: unknown = null;
  #settled = false;
  #reason: "cancelled" | "timeout" | "closed" | null = null;

  constructor(timeoutMs = 0, private readonly clock: Clock = systemClock) {
    if (timeoutMs > 0) {
      this.#timer = this.clock.setTimeout(() => this.abort("timeout"), timeoutMs);
      (this.#timer as { unref?: () => void })?.unref?.();
    }
  }

  get signal(): AbortSignal { return this.controller.signal; }
  get aborted(): boolean { return this.controller.signal.aborted; }
  get reason(): "cancelled" | "timeout" | "closed" | null { return this.#reason; }
  /** True once the response has been written, after which nothing may be sent. */
  get settled(): boolean { return this.#settled; }

  abort(reason: "cancelled" | "timeout" | "closed"): void {
    if (this.controller.signal.aborted || this.#settled) return;
    this.#reason = reason;
    this.controller.abort(new Error(reason));
  }

  /** Marks the response written. Idempotent, and clears the timer. */
  settle(): void {
    this.#settled = true;
    if (this.#timer !== null) {
      this.clock.clearTimeout(this.#timer);
      this.#timer = null;
    }
  }
}
