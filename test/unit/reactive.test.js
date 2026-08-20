import test from "node:test";
import assert from "node:assert/strict";
import { signal, computed, effect, batch, untracked } from "../../dist/view/reactive.js";

test("an effect runs once immediately", () => {
  const runs = [];
  effect(() => runs.push("ran"));
  assert.deepEqual(runs, ["ran"]);
});

test("an effect reruns when a signal it read changes", () => {
  const n = signal(1);
  const seen = [];
  effect(() => seen.push(n()));
  n.set(2);
  n.set(3);
  assert.deepEqual(seen, [1, 2, 3]);
});

test("setting a signal to the same value reruns nothing", () => {
  const n = signal(1);
  let runs = 0;
  effect(() => { n(); runs += 1; });
  n.set(1);
  n.set(1);
  assert.equal(runs, 1, "an unchanged value must not cost a render");
});

test("only the effects that read a signal rerun", () => {
  const a = signal("a"), b = signal("b");
  let aRuns = 0, bRuns = 0;
  effect(() => { a(); aRuns += 1; });
  effect(() => { b(); bRuns += 1; });
  a.set("a2");
  assert.equal(aRuns, 2);
  assert.equal(bRuns, 1, "an unrelated effect reran; this is the rerun model we rejected");
});

test("dependencies are re-collected each run, so a branch not taken is not tracked", () => {
  const on = signal(true), used = signal("x"), unused = signal("y");
  let runs = 0;
  effect(() => { runs += 1; on() ? used() : unused(); });
  assert.equal(runs, 1);
  unused.set("y2");
  assert.equal(runs, 1, "an untaken branch must not create a dependency");
  used.set("x2");
  assert.equal(runs, 2);
});

test("a computed recomputes only when its inputs change", () => {
  const first = signal(2), second = signal(3);
  let computations = 0;
  const product = computed(() => { computations += 1; return first() * second(); });
  assert.equal(product(), 6);
  assert.equal(computations, 1);
  first.set(4);
  assert.equal(product(), 12);
  assert.equal(computations, 2);
});

test("an effect on a computed sees its new value", () => {
  const n = signal(1);
  const doubled = computed(() => n() * 2);
  const seen = [];
  effect(() => seen.push(doubled()));
  n.set(5);
  assert.deepEqual(seen, [2, 10]);
});

test("batch renders once however many signals change", () => {
  const a = signal(1), b = signal(1);
  let runs = 0;
  effect(() => { a(); b(); runs += 1; });
  assert.equal(runs, 1);
  batch(() => { a.set(2); b.set(2); });
  assert.equal(runs, 2, "two changes in one event must cost one render");
});

test("untracked reads without subscribing", () => {
  const tracked = signal(1), hidden = signal(1);
  let runs = 0;
  effect(() => { tracked(); untracked(() => hidden()); runs += 1; });
  hidden.set(2);
  assert.equal(runs, 1);
  tracked.set(2);
  assert.equal(runs, 2);
});

test("disposing an effect stops it and releases its subscriptions", () => {
  const n = signal(1);
  let runs = 0;
  const stop = effect(() => { n(); runs += 1; });
  n.set(2);
  assert.equal(runs, 2);
  stop();
  n.set(3);
  assert.equal(runs, 2, "a disposed effect must not run again");
});

test("cleanups run before the next pass and on disposal", () => {
  const n = signal(1);
  const log = [];
  const stop = effect((onCleanup) => {
    const value = n();
    onCleanup(() => log.push(`cleanup ${value}`));
  });
  n.set(2);
  assert.deepEqual(log, ["cleanup 1"]);
  stop();
  assert.deepEqual(log, ["cleanup 1", "cleanup 2"]);
});

test("a signal derives its next value with update", () => {
  const n = signal(1);
  n.update((previous) => previous + 1);
  assert.equal(n(), 2);
});

test("peek reads without subscribing even inside an effect", () => {
  const n = signal(1);
  let runs = 0;
  effect(() => { n.peek(); runs += 1; });
  n.set(2);
  assert.equal(runs, 1);
});

test("a signal can hold a function, because set never interprets it", () => {
  const fn = (n) => n * 2;
  const s = signal(null);
  s.set(fn);
  assert.equal(s(), fn, "set called the function as an updater instead of storing it");
  assert.equal(s()(21), 42);
});

test("a computed may return a function", () => {
  const locale = signal("en-US");
  const format = computed(() => (n) => new Intl.NumberFormat(locale()).format(n));
  assert.equal(typeof format(), "function");
  assert.equal(format()(1234567), "1,234,567");
});
