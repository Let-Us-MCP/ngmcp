/** The smallest thing that answers Panel's first decision.
 *
 * Panel reruns only the functions whose declared dependencies changed, rather
 * than the whole script. That is not a preference in a view: rerunning means
 * re-calling tools, and a tool call leaves the frame. Sorting a table cannot
 * cost a round trip.
 *
 * Dependencies are tracked by reading rather than declaring. A computation
 * runs, every signal it touches records it, and changing one of those signals
 * reruns exactly that computation and nothing else.
 */

type Cleanup = () => void;

interface Computation {
  run(): void;
  dependencies: Set<Set<Computation>>;
  cleanups: Cleanup[];
  disposed: boolean;
}

let current: Computation | null = null;
/** Batched updates, so one event never renders twice. */
let pending: Set<Computation> | null = null;

export interface Signal<T> {
  (): T;
  /** Store a value. Stored as given, including when it is a function. */
  set(value: T): void;
  /** Derive the next value from the current one. */
  update(next: (previous: T) => T): void;
  peek(): T;
}

export function signal<T>(initial: T, equals: (a: T, b: T) => boolean = Object.is): Signal<T> {
  let value = initial;
  const subscribers = new Set<Computation>();

  const read = (() => {
    if (current) {
      subscribers.add(current);
      current.dependencies.add(subscribers);
    }
    return value;
  }) as Signal<T>;

  read.peek = () => value;
  // `set` stores what it is given and never interprets it. Treating a
  // function argument as an updater is the usual shortcut, and it makes a
  // signal unable to hold a function, which is exactly what a computed value
  // that returns a formatter needs to do. `update` is the separate verb.
  read.set = (next) => {
    if (equals(value, next)) return;
    value = next;
    if (pending) {
      for (const s of subscribers) pending.add(s);
      return;
    }
    // Copied, because a computation may resubscribe while we iterate.
    for (const s of [...subscribers]) if (!s.disposed) s.run();
  };
  read.update = (next) => read.set(next(value));
  return read;
}

function dispose(computation: Computation): void {
  for (const set of computation.dependencies) set.delete(computation);
  computation.dependencies.clear();
  for (const cleanup of computation.cleanups.splice(0)) cleanup();
}

/** Run now, and again whenever anything it read changes. */
export function effect(fn: (onCleanup: (c: Cleanup) => void) => void): Cleanup {
  const computation: Computation = {
    dependencies: new Set(),
    cleanups: [],
    disposed: false,
    run() {
      if (this.disposed) return;
      dispose(this);
      const previous = current;
      current = this;
      try {
        fn((c) => this.cleanups.push(c));
      } finally {
        current = previous;
      }
    },
  };
  computation.run();
  return () => {
    computation.disposed = true;
    dispose(computation);
  };
}

/** A value derived from other signals, recomputed only when they change. */
export function computed<T>(fn: () => T, equals?: (a: T, b: T) => boolean): Signal<T> {
  const out = signal<T>(undefined as T, equals);
  effect(() => out.set(fn()));
  return out;
}

/** One render per event, however many signals an event touches. */
export function batch<T>(fn: () => T): T {
  if (pending) return fn();
  pending = new Set();
  try {
    return fn();
  } finally {
    const queued = pending;
    pending = null;
    for (const computation of queued) if (!computation.disposed) computation.run();
  }
}

/** Read without subscribing. */
export function untracked<T>(fn: () => T): T {
  const previous = current;
  current = null;
  try { return fn(); } finally { current = previous; }
}
