"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { RateLimiter, MemoryStore, rateLimit, TokenBucket } = require("../src");

function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

// Start a real HTTP server with the middleware in front of a trivial handler.
async function startServer({
  capacity = 3,
  refillPerSec = 1,
  limiter,
  ...opts
} = {}) {
  const now = fakeClock();
  limiter =
    limiter ||
    new RateLimiter({
      capacity,
      refillPerSec,
      store: new MemoryStore({ now, cleanupIntervalMs: 0 }),
    });

  const mw = rateLimit({ limiter, now, ...opts });
  const server = http.createServer((req, res) => {
    mw(req, res, () => {
      res.statusCode = 200;
      res.end("ok");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    now,
    limiter,
    close: async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await limiter.close();
    },
  };
}

test("TokenBucket reports resetMs (time until full)", () => {
  const now = fakeClock();
  const b = new TokenBucket({ capacity: 4, refillPerSec: 2, now });
  assert.equal(b.consume().resetMs, 500); // 1 missing token / 2 per sec
  assert.equal(b.consume().resetMs, 1000); // 2 missing
});

test("allowed requests pass through with rate limit headers", async () => {
  const s = await startServer({ capacity: 3 });
  try {
    const r1 = await fetch(s.url);
    assert.equal(r1.status, 200);
    assert.equal(await r1.text(), "ok");
    assert.equal(r1.headers.get("x-ratelimit-limit"), "3");
    assert.equal(r1.headers.get("x-ratelimit-remaining"), "2");
    assert.ok(Number(r1.headers.get("x-ratelimit-reset")) > 0);
    assert.equal(r1.headers.get("retry-after"), null);

    const r2 = await fetch(s.url);
    assert.equal(r2.headers.get("x-ratelimit-remaining"), "1");
  } finally {
    await s.close();
  }
});

test("reset header is a unix timestamp in seconds from the injected clock", async () => {
  const s = await startServer({ capacity: 2, refillPerSec: 1 });
  try {
    const r = await fetch(s.url); // 1 token missing => full in 1s
    const expected = Math.ceil((s.now() + 1000) / 1000);
    assert.equal(Number(r.headers.get("x-ratelimit-reset")), expected);
  } finally {
    await s.close();
  }
});

test("returns 429 with Retry-After once the bucket is empty", async () => {
  const s = await startServer({ capacity: 2, refillPerSec: 1 });
  try {
    await fetch(s.url);
    await fetch(s.url);
    const res = await fetch(s.url);

    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "1");
    assert.equal(res.headers.get("x-ratelimit-remaining"), "0");
    assert.match(res.headers.get("content-type"), /application\/json/);
    assert.deepEqual(await res.json(), {
      error: "Too Many Requests",
      retryAfterSeconds: 1,
    });
  } finally {
    await s.close();
  }
});

test("Retry-After rounds up to whole seconds (never 0)", async () => {
  // 1 token per 2.5s => retry in 2500ms => "3"
  const s = await startServer({ capacity: 1, refillPerSec: 0.4 });
  try {
    await fetch(s.url);
    const res = await fetch(s.url);
    assert.equal(res.headers.get("retry-after"), "3");
  } finally {
    await s.close();
  }
});

test("client is allowed again after waiting", async () => {
  const s = await startServer({ capacity: 1, refillPerSec: 1 });
  try {
    assert.equal((await fetch(s.url)).status, 200);
    assert.equal((await fetch(s.url)).status, 429);
    s.now.advance(1000);
    assert.equal((await fetch(s.url)).status, 200);
  } finally {
    await s.close();
  }
});

test("keyGenerator separates clients", async () => {
  const s = await startServer({
    capacity: 1,
    keyGenerator: (req) => req.headers["x-api-key"],
  });
  try {
    const hit = (key) => fetch(s.url, { headers: { "x-api-key": key } });
    assert.equal((await hit("alice")).status, 200);
    assert.equal((await hit("alice")).status, 429);
    assert.equal((await hit("bob")).status, 200);
  } finally {
    await s.close();
  }
});

test("default key is the client address (all local requests share one bucket)", async () => {
  const s = await startServer({ capacity: 1 });
  try {
    assert.equal((await fetch(s.url)).status, 200);
    assert.equal((await fetch(s.url)).status, 429);
  } finally {
    await s.close();
  }
});

test("skip bypasses limiting and sends no headers", async () => {
  const s = await startServer({
    capacity: 1,
    skip: (req) => req.url === "/health",
  });
  try {
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${s.url}/health`);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("x-ratelimit-limit"), null);
    }
  } finally {
    await s.close();
  }
});

test("cost can depend on the request", async () => {
  const s = await startServer({
    capacity: 5,
    cost: (req) => (req.url.startsWith("/expensive") ? 5 : 1),
  });
  try {
    assert.equal((await fetch(`${s.url}/expensive`)).status, 200);
    assert.equal((await fetch(s.url)).status, 429); // bucket drained
  } finally {
    await s.close();
  }
});

test("headers can be disabled", async () => {
  const s = await startServer({ headers: false });
  try {
    const r = await fetch(s.url);
    assert.equal(r.headers.get("x-ratelimit-limit"), null);
  } finally {
    await s.close();
  }
});

test("custom onLimited handler controls the 429 response", async () => {
  const s = await startServer({
    capacity: 1,
    onLimited: (req, res) => {
      res.statusCode = 429;
      res.end("slow down");
    },
  });
  try {
    await fetch(s.url);
    const r = await fetch(s.url);
    assert.equal(r.status, 429);
    assert.equal(await r.text(), "slow down");
    assert.equal(r.headers.get("retry-after"), "1"); // header still set
  } finally {
    await s.close();
  }
});

const brokenLimiter = () => ({
  check: async () => {
    throw new Error("store down");
  },
  close: async () => {},
});

test("fails OPEN by default when the limiter errors, and reports the error", async () => {
  const errors = [];
  const s = await startServer({
    limiter: brokenLimiter(),
    onError: (e) => errors.push(e.message),
  });
  try {
    assert.equal((await fetch(s.url)).status, 200);
    assert.deepEqual(errors, ["store down"]);
  } finally {
    await s.close();
  }
});

test("failOpen:false returns 503 when the limiter errors", async () => {
  const s = await startServer({ limiter: brokenLimiter(), failOpen: false });
  try {
    assert.equal((await fetch(s.url)).status, 503);
  } finally {
    await s.close();
  }
});

test("a missing key is treated as a limiter error, not silently allowed unseen", async () => {
  const errors = [];
  const s = await startServer({
    keyGenerator: () => undefined,
    onError: (e) => errors.push(e.constructor.name),
  });
  try {
    await fetch(s.url);
    assert.deepEqual(errors, ["TypeError"]);
  } finally {
    await s.close();
  }
});

test("errors thrown by downstream handlers are not swallowed as limiter errors", async () => {
  const limiter = new RateLimiter({ capacity: 5, refillPerSec: 1 });
  const errors = [];
  const mw = rateLimit({ limiter, onError: (e) => errors.push(e) });
  let nextCalls = 0;

  await assert.rejects(
    () =>
      mw({ ip: "1.1.1.1" }, { setHeader() {}, end() {} }, () => {
        nextCalls++;
        throw new Error("handler bug");
      }),
    /handler bug/,
  );
  assert.equal(nextCalls, 1); // next() not called a second time
  assert.equal(errors.length, 0);
  await limiter.close();
});

test("rateLimit requires a limiter", () => {
  assert.throws(() => rateLimit({}), TypeError);
});
