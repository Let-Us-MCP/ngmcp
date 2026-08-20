import test from "node:test";
import assert from "node:assert/strict";
import { Limiter, RequestLifetime } from "../../dist/runtime/concurrency.js";

const virtualClock = () => {
  const timers = new Map();
  let id = 0, now = 0;
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const key = ++id; timers.set(key, { fn, at: now + ms }); return key; },
    clearTimeout: (key) => { timers.delete(key); },
    advance(ms) {
      now += ms;
      for (const [key, t] of [...timers]) if (t.at <= now) { timers.delete(key); t.fn(); }
    },
  };
};

test("a limiter runs at most the configured number at once", async () => {
  const limiter = new Limiter(2);
  let peak = 0, active = 0;
  const task = async () => {
    active += 1; peak = Math.max(peak, active);
    await new Promise((r) => setImmediate(r));
    active -= 1;
  };
  await Promise.all(Array.from({ length: 10 }, () => limiter.run(task)));
  assert.equal(peak, 2);
  assert.equal(limiter.active, 0);
  assert.equal(limiter.queued, 0);
});

test("a limit of zero means unbounded", async () => {
  const limiter = new Limiter(0);
  let peak = 0, active = 0;
  const task = async () => {
    active += 1; peak = Math.max(peak, active);
    await new Promise((r) => setImmediate(r));
    active -= 1;
  };
  await Promise.all(Array.from({ length: 8 }, () => limiter.run(task)));
  assert.equal(peak, 8);
});

test("a limiter releases its slot when a task throws", async () => {
  const limiter = new Limiter(1);
  await assert.rejects(() => limiter.run(async () => { throw new Error("boom"); }));
  assert.equal(limiter.active, 0);
  await limiter.run(async () => "fine");
  assert.equal(limiter.active, 0);
});

test("a lifetime aborts on cancellation and remembers why", () => {
  const lifetime = new RequestLifetime(0);
  assert.equal(lifetime.aborted, false);
  lifetime.abort("cancelled");
  assert.equal(lifetime.aborted, true);
  assert.equal(lifetime.reason, "cancelled");
});

test("a lifetime aborts on timeout, on a clock the test controls", () => {
  const clock = virtualClock();
  const lifetime = new RequestLifetime(1000, clock);
  clock.advance(999);
  assert.equal(lifetime.aborted, false);
  clock.advance(1);
  assert.equal(lifetime.aborted, true);
  assert.equal(lifetime.reason, "timeout");
});

test("a settled lifetime cannot be aborted afterwards", () => {
  const clock = virtualClock();
  const lifetime = new RequestLifetime(1000, clock);
  lifetime.settle();
  clock.advance(5000);
  assert.equal(lifetime.aborted, false, "a timer must not fire after the response went out");
  lifetime.abort("cancelled");
  assert.equal(lifetime.aborted, false);
});

test("settling clears the timer so nothing is left running", () => {
  const clock = virtualClock();
  const lifetime = new RequestLifetime(50, clock);
  lifetime.settle();
  clock.advance(100);
  assert.equal(lifetime.reason, null);
});
