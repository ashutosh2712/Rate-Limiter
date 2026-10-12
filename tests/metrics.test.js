"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const {
  RateLimiter,
  MemoryStore,
  rateLimit,
  createMetrics,
} = require("../src");

const fakeRes = () => ({
  headers: {},
  setHeader(k, v) {
    this.headers[k] = v;
  },
  end() {},
  statusCode: 0,
});
const limiterOf = (capacity, store) =>
  new RateLimiter({
    capacity,
    refillPerSec: 0.001,
    store: store || new MemoryStore({ cleanupIntervalMs: 0 }),
  });

// ---------- onDecision hook ----------

test("hook reports allowed and blocked with limit details and duration", async () => {
  const events = [];
  const mw = rateLimit({
    limiter: limiterOf(1),
    keyGenerator: () => "k",
    onDecision: (e) => events.push(e),
  });

  await mw({}, fakeRes(), () => {});
  await mw({}, fakeRes(), () => {});

  assert.deepEqual(
    events.map((e) => e.outcome),
    ["allowed", "blocked"],
  );
  assert.equal(events[0].limit, 1);
  assert.equal(events[0].remaining, 0);
  assert.equal(events[1].retryAfterMs > 0, true);
  assert.equal(typeof events[0].durationMs, "number");
  assert.ok(events[0].durationMs >= 0);
  assert.ok(
    events[0].req,
    "the request is passed through for custom labelling",
  );
});

test("hook reports skipped requests (skip option) and all-rules-skipped requests", async () => {
  const events = [];
  const l = limiterOf(1);
  const skipMw = rateLimit({
    limiter: l,
    skip: () => true,
    onDecision: (e) => events.push(e),
  });
  const nullKeyMw = rateLimit({
    limiter: l,
    keyGenerator: () => null,
    onDecision: (e) => events.push(e),
  });

  await skipMw({}, fakeRes(), () => {});
  await nullKeyMw({}, fakeRes(), () => {});
  assert.deepEqual(
    events.map((e) => e.outcome),
    ["skipped", "skipped"],
  );
});

test("hook reports limiter errors, including whether the request failed open", async () => {
  const broken = {
    check: async () => {
      throw new Error("store down");
    },
  };
  const events = [];

  await rateLimit({ limiter: broken, onDecision: (e) => events.push(e) })(
    { ip: "x" },
    fakeRes(),
    () => {},
  );
  await rateLimit({
    limiter: broken,
    failOpen: false,
    onDecision: (e) => events.push(e),
  })({ ip: "x" }, fakeRes(), () => {});

  assert.deepEqual(
    events.map((e) => e.outcome),
    ["error", "error"],
  );
  assert.deepEqual(
    events.map((e) => e.failedOpen),
    [true, false],
  );
  assert.equal(events[0].error.message, "store down");
});

test("a throwing or rejecting hook never breaks the request", async () => {
  let nextCalls = 0;
  const next = () => {
    nextCalls++;
  };

  const sync = rateLimit({
    limiter: limiterOf(5),
    keyGenerator: () => "a",
    onDecision: () => {
      throw new Error("metrics bug");
    },
  });
  const async_ = rateLimit({
    limiter: limiterOf(5),
    keyGenerator: () => "a",
    onDecision: async () => {
      throw new Error("async bug");
    },
  });

  await sync({}, fakeRes(), next);
  await async_({}, fakeRes(), next);
  await new Promise((r) => setImmediate(r)); // give a rejected promise the chance to surface as unhandled
  assert.equal(nextCalls, 2);
});

// ---------- createMetrics ----------

test("counts outcomes and tracks latency", () => {
  const m = createMetrics();
  m.record({ outcome: "allowed", durationMs: 1 });
  m.record({ outcome: "allowed", durationMs: 3 });
  m.record({ outcome: "blocked", durationMs: 2 });
  m.record({ outcome: "error", durationMs: 200 });
  m.record({ outcome: "skipped", durationMs: 0 });
  m.record({ outcome: "bogus", durationMs: 5 }); // ignored

  const s = m.snapshot();
  assert.deepEqual(
    {
      allowed: s.allowed,
      blocked: s.blocked,
      error: s.error,
      skipped: s.skipped,
      total: s.total,
    },
    { allowed: 2, blocked: 1, error: 1, skipped: 1, total: 5 },
  );
  assert.equal(s.latency.count, 4); // skipped has no latency
  assert.equal(s.latency.sumMs, 206);
  assert.equal(s.latency.avgMs, 51.5);
});

test("record works unbound, so it can be passed straight to onDecision", () => {
  const { record, snapshot } = createMetrics();
  record({ outcome: "allowed", durationMs: 1 });
  assert.equal(snapshot().allowed, 1);
});

test("Prometheus output has cumulative buckets, +Inf, sum and count", () => {
  const m = createMetrics({ bucketsMs: [1, 10] });
  m.record({ outcome: "allowed", durationMs: 0.5 }); // <= 1
  m.record({ outcome: "allowed", durationMs: 5 }); // <= 10
  m.record({ outcome: "blocked", durationMs: 50 }); // +Inf only

  const text = m.toPrometheus();
  const line = (re) => text.split("\n").find((l) => re.test(l));

  assert.match(text, /# TYPE ratelimit_requests_total counter/);
  assert.equal(
    line(/outcome="allowed"/),
    'ratelimit_requests_total{outcome="allowed"} 2',
  );
  assert.equal(
    line(/outcome="blocked"/),
    'ratelimit_requests_total{outcome="blocked"} 1',
  );
  assert.equal(
    line(/le="0.001"/),
    'ratelimit_check_duration_seconds_bucket{le="0.001"} 1',
  );
  assert.equal(
    line(/le="0.01"/),
    'ratelimit_check_duration_seconds_bucket{le="0.01"} 2',
  ); // cumulative
  assert.equal(
    line(/le="\+Inf"/),
    'ratelimit_check_duration_seconds_bucket{le="+Inf"} 3',
  );
  assert.equal(line(/_count/), "ratelimit_check_duration_seconds_count 3");
  assert.ok(Math.abs(Number(line(/_sum/).split(" ")[1]) - 0.0555) < 1e-9);
  assert.ok(text.endsWith("\n"));
});

test("custom prefix and reset()", () => {
  const m = createMetrics();
  m.record({ outcome: "allowed", durationMs: 1 });
  assert.match(
    m.toPrometheus({ prefix: "myapp_rl" }),
    /myapp_rl_requests_total\{outcome="allowed"\} 1/,
  );
  m.reset();
  assert.equal(m.snapshot().total, 0);
  assert.equal(m.snapshot().latency.count, 0);
});

// ---------- end to end ----------

test("END TO END: metrics through a real HTTP server", async () => {
  const metrics = createMetrics();
  const mw = rateLimit({
    limiter: limiterOf(2),
    keyGenerator: () => "k",
    skip: (req) => req.url === "/metrics",
    onDecision: metrics.record,
  });
  // Like a real app: the limiter runs first, and /metrics is exempted via `skip`.
  const server = http.createServer((req, res) => {
    mw(req, res, () => {
      res.statusCode = 200;
      res.end(req.url === "/metrics" ? metrics.toPrometheus() : "ok");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    for (let i = 0; i < 5; i++) await (await fetch(url)).text(); // 2 allowed, 3 blocked
    const body = await (await fetch(`${url}/metrics`)).text();

    assert.match(body, /ratelimit_requests_total\{outcome="allowed"\} 2/);
    assert.match(body, /ratelimit_requests_total\{outcome="blocked"\} 3/);
    assert.match(body, /ratelimit_requests_total\{outcome="skipped"\} 1/); // the scrape itself
    assert.match(body, /ratelimit_check_duration_seconds_count 5/);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
