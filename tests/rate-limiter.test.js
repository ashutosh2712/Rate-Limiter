"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { RateLimiter } = require("../src/rate-limiter");
const { MemoryStore } = require("../src/memory-store");
const { TokenBucket } = require("../src/token-bucket");

function fakeClock(start = 0) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

// Helper: limiter wired to a fake clock, with the cleanup timer off.
function setup({ capacity = 3, refillPerSec = 1 } = {}) {
  const now = fakeClock();
  const store = new MemoryStore({ now, cleanupIntervalMs: 0 });
  const limiter = new RateLimiter({ capacity, refillPerSec, store });
  return { now, store, limiter };
}

test("TokenBucket.isFull reflects refill state", () => {
  const now = fakeClock();
  const b = new TokenBucket({ capacity: 2, refillPerSec: 1, now });
  assert.equal(b.isFull(), true);
  b.consume();
  assert.equal(b.isFull(), false);
  now.advance(1000);
  assert.equal(b.isFull(), true);
});

test("limiter allows up to capacity then blocks", async () => {
  const { limiter } = setup({ capacity: 3 });
  for (let i = 0; i < 3; i++) {
    assert.equal((await limiter.check("a")).allowed, true);
  }
  const res = await limiter.check("a");
  assert.equal(res.allowed, false);
  assert.equal(res.limit, 3);
  assert.ok(res.retryAfterMs > 0);
});

test("keys are isolated from each other", async () => {
  const { limiter } = setup({ capacity: 1 });
  assert.equal((await limiter.check("alice")).allowed, true);
  assert.equal((await limiter.check("alice")).allowed, false);
  assert.equal((await limiter.check("bob")).allowed, true); // unaffected by alice
});

test("limiter recovers after time passes", async () => {
  const { limiter, now } = setup({ capacity: 1, refillPerSec: 1 });
  await limiter.check("a");
  assert.equal((await limiter.check("a")).allowed, false);
  now.advance(1000);
  assert.equal((await limiter.check("a")).allowed, true);
});

test("cleanup removes idle (fully refilled) buckets only", async () => {
  const { limiter, store, now } = setup({ capacity: 2, refillPerSec: 1 });

  await limiter.check("idle"); // 1 token left, needs 1s to refill
  now.advance(5000);
  await limiter.check("busy"); // just used, not full
  await limiter.check("busy");
  assert.equal(store.size, 2);

  const removed = store.cleanup();
  assert.equal(removed, 1);
  assert.equal(store.size, 1);
  assert.equal(store.buckets.has("default:busy"), true);
  assert.equal(store.buckets.has("default:idle"), false);
});

test("behavior is identical after a bucket is cleaned up and recreated", async () => {
  const { limiter, store, now } = setup({ capacity: 2, refillPerSec: 1 });
  await limiter.check("a");
  now.advance(10_000);
  store.cleanup();
  assert.equal(store.size, 0);

  // Fresh bucket: full burst available again
  assert.equal((await limiter.check("a")).remaining, 1);
});

test("cleanup timer is unref-ed and close() stops it", async () => {
  const store = new MemoryStore({ cleanupIntervalMs: 1000 });
  assert.equal(store._timer.hasRef(), false); // won't keep the process alive
  await store.close();
  assert.equal(store._timer, null);
});

test("limiter validates its inputs", async () => {
  assert.throws(
    () => new RateLimiter({ capacity: 0, refillPerSec: 1 }),
    RangeError,
  );
  const { limiter } = setup();
  await assert.rejects(() => limiter.check(""), TypeError);
  await assert.rejects(() => limiter.check(42), TypeError);
});

test("concurrent checks on one key never exceed capacity", async () => {
  const { limiter } = setup({ capacity: 5 });
  const results = await Promise.all(
    Array.from({ length: 20 }, () => limiter.check("hot")),
  );
  assert.equal(results.filter((r) => r.allowed).length, 5);
});
