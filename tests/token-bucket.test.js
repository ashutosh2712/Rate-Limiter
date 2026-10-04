"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { TokenBucket } = require("../src/token-bucket");

// Fake clock: we control time by hand.
function fakeClock(start = 0) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

test("allows a full burst up to capacity, then rejects", () => {
  const now = fakeClock();
  const b = new TokenBucket({ capacity: 5, refillPerSec: 1, now });

  for (let i = 0; i < 5; i++) {
    assert.equal(b.consume().allowed, true, `request ${i + 1} should pass`);
  }
  const res = b.consume();
  assert.equal(res.allowed, false);
  assert.equal(res.remaining, 0);
});

test("reports remaining tokens", () => {
  const b = new TokenBucket({ capacity: 3, refillPerSec: 1, now: fakeClock() });
  assert.equal(b.consume().remaining, 2);
  assert.equal(b.consume().remaining, 1);
  assert.equal(b.consume().remaining, 0);
});

test("refills over time", () => {
  const now = fakeClock();
  const b = new TokenBucket({ capacity: 2, refillPerSec: 1, now });
  b.consume();
  b.consume();
  assert.equal(b.consume().allowed, false);

  now.advance(1000); // +1 token
  assert.equal(b.consume().allowed, true);
  assert.equal(b.consume().allowed, false);
});

test("never refills beyond capacity", () => {
  const now = fakeClock();
  const b = new TokenBucket({ capacity: 3, refillPerSec: 10, now });
  b.consume();
  now.advance(60_000); // a long idle period
  assert.equal(b.consume().remaining, 2); // 3 (capped) - 1
});

test("retryAfterMs tells when the next token arrives", () => {
  const now = fakeClock();
  const b = new TokenBucket({ capacity: 1, refillPerSec: 2, now }); // 1 token per 500ms
  b.consume();

  assert.equal(b.consume().retryAfterMs, 500);
  now.advance(200);
  assert.equal(b.consume().retryAfterMs, 300);
  now.advance(300);
  assert.equal(b.consume().allowed, true);
});

test("supports weighted cost", () => {
  const b = new TokenBucket({
    capacity: 10,
    refillPerSec: 1,
    now: fakeClock(),
  });
  assert.equal(b.consume(7).allowed, true);
  assert.equal(b.consume(7).allowed, false); // only 3 left
  assert.equal(b.consume(3).allowed, true);
});

test("fractional refill accumulates correctly", () => {
  const now = fakeClock();
  const b = new TokenBucket({ capacity: 1, refillPerSec: 1, now });
  b.consume();
  now.advance(400);
  assert.equal(b.consume().allowed, false);
  now.advance(600); // total 1000ms since consume
  assert.equal(b.consume().allowed, true);
});

test("ignores a clock that goes backwards", () => {
  const now = fakeClock(10_000);
  const b = new TokenBucket({ capacity: 2, refillPerSec: 1, now });
  b.consume();
  b.consume();
  now.advance(-5000);
  assert.equal(b.consume().allowed, false);
});

test("validates constructor and cost arguments", () => {
  assert.throws(
    () => new TokenBucket({ capacity: 0, refillPerSec: 1 }),
    RangeError,
  );
  assert.throws(
    () => new TokenBucket({ capacity: 1, refillPerSec: 0 }),
    RangeError,
  );
  const b = new TokenBucket({ capacity: 2, refillPerSec: 1 });
  assert.throws(() => b.consume(3), RangeError);
  assert.throws(() => b.consume(0), RangeError);
});
