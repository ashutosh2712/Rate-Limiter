"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { RateLimiter, MemoryStore, rateLimit, rate, byTier } = require("../src");

function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

// Tiny server: `build(now)` returns the request handler under test.
async function serve(build) {
  const now = fakeClock();
  const handler = build(now);
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    now,
    url: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

const ok = (res) => {
  res.statusCode = 200;
  res.end("ok");
};

// ---------- rate() ----------

test("rate() converts limit/window into capacity and refill rate", () => {
  const r = rate({ limit: 120, per: "minute" });
  assert.equal(r.capacity, 120);
  assert.equal(r.refillPerSec, 2);

  assert.deepEqual(rate({ limit: 10, per: "second", burst: 3 }), {
    capacity: 3,
    refillPerSec: 10,
  });
  assert.equal(rate({ limit: 5, per: 15 * 60_000 }).refillPerSec, 5 / 900);
  assert.equal(rate({ limit: 24, per: "day" }).refillPerSec, 24 / 86_400);
});

test("rate() rejects bad input", () => {
  assert.throws(() => rate({ limit: 0, per: "minute" }), RangeError);
  assert.throws(() => rate({ limit: 5, per: "fortnight" }), RangeError);
  assert.throws(() => rate({ limit: 5, per: "minute", burst: 0 }), RangeError);
});

// ---------- namespacing ----------

test("limiters sharing a store do not collide when named differently", async () => {
  const store = new MemoryStore({ cleanupIntervalMs: 0 });
  const login = new RateLimiter({
    name: "login",
    capacity: 1,
    refillPerSec: 1,
    store,
  });
  const search = new RateLimiter({
    name: "search",
    capacity: 1,
    refillPerSec: 1,
    store,
  });

  assert.equal((await login.check("user:42")).allowed, true);
  assert.equal((await login.check("user:42")).allowed, false);
  assert.equal((await search.check("user:42")).allowed, true); // separate bucket
  await store.close();
});

test("limiters with the same name and store share state", async () => {
  const store = new MemoryStore({ cleanupIntervalMs: 0 });
  const a = new RateLimiter({ name: "x", capacity: 1, refillPerSec: 1, store });
  const b = new RateLimiter({ name: "x", capacity: 1, refillPerSec: 1, store });
  await a.check("k");
  assert.equal((await b.check("k")).allowed, false);
  await store.close();
});

test("name must be a non-empty string", () => {
  assert.throws(
    () => new RateLimiter({ name: "", capacity: 1, refillPerSec: 1 }),
    TypeError,
  );
});

// ---------- tiers ----------

function tierServer(extra = {}) {
  return serve((now) => {
    const store = new MemoryStore({ now, cleanupIntervalMs: 0 });
    const limiter = byTier({
      store,
      tiers: {
        free: { capacity: 2, refillPerSec: 1 },
        pro: { capacity: 5, refillPerSec: 1 },
      },
      getTier: (req) => req.headers["x-plan"], // test only; real code uses auth, not a header
      defaultTier: "free",
      ...extra,
    });
    const mw = rateLimit({
      limiter,
      now,
      keyGenerator: (req) => req.headers["x-user"],
    });
    return (req, res) => mw(req, res, () => ok(res));
  });
}

test("tiers get different limits", async () => {
  const s = await tierServer();
  try {
    const hit = (plan) =>
      fetch(s.url, { headers: { "x-plan": plan, "x-user": plan } });

    const free = await hit("free");
    assert.equal(free.headers.get("x-ratelimit-limit"), "2");
    const pro = await hit("pro");
    assert.equal(pro.headers.get("x-ratelimit-limit"), "5");

    await hit("free");
    assert.equal((await hit("free")).status, 429); // free exhausted after 2
    for (let i = 0; i < 4; i++) await hit("pro"); // pro had 5 total
    assert.equal((await hit("pro")).status, 429);
  } finally {
    await s.close();
  }
});

test("unknown or missing tier falls back to the default", async () => {
  const s = await tierServer();
  try {
    const r = await fetch(s.url, {
      headers: { "x-plan": "platinum", "x-user": "u1" },
    });
    assert.equal(r.headers.get("x-ratelimit-limit"), "2");
    const r2 = await fetch(s.url, { headers: { "x-user": "u2" } }); // no plan header
    assert.equal(r2.headers.get("x-ratelimit-limit"), "2");
  } finally {
    await s.close();
  }
});

test("prototype-property tier names cannot hijack the lookup", async () => {
  const s = await tierServer();
  try {
    for (const evil of [
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
    ]) {
      const r = await fetch(s.url, {
        headers: { "x-plan": evil, "x-user": `u-${evil}` },
      });
      assert.equal(r.status, 200, evil);
      assert.equal(r.headers.get("x-ratelimit-limit"), "2", evil); // default tier
    }
  } finally {
    await s.close();
  }
});

test("byTier validates configuration", () => {
  const tiers = { free: { capacity: 1, refillPerSec: 1 } };
  assert.throws(
    () => byTier({ tiers: {}, getTier: () => "x", defaultTier: "x" }),
    TypeError,
  );
  assert.throws(
    () => byTier({ tiers, getTier: () => "free", defaultTier: "nope" }),
    TypeError,
  );
  assert.throws(
    () => byTier({ tiers, getTier: "free", defaultTier: "free" }),
    TypeError,
  );
  assert.throws(
    () => byTier({ tiers, getTier: () => "free", defaultTier: "toString" }),
    TypeError,
  );
});

// ---------- composition ----------

function composeServer({ rulesFor }) {
  return serve((now) => {
    const store = new MemoryStore({ now, cleanupIntervalMs: 0 });
    const mw = rateLimit({ now, rules: rulesFor(store) });
    return (req, res) => mw(req, res, () => ok(res));
  });
}

test("all rules must allow; the denying rule decides the response", async () => {
  const s = await composeServer({
    rulesFor: (store) => [
      {
        limiter: new RateLimiter({
          name: "strict",
          capacity: 1,
          refillPerSec: 1,
          store,
        }),
        keyGenerator: () => "k",
      },
      {
        limiter: new RateLimiter({
          name: "loose",
          capacity: 10,
          refillPerSec: 1,
          store,
        }),
        keyGenerator: () => "k",
      },
    ],
  });
  try {
    assert.equal((await fetch(s.url)).status, 200);
    const denied = await fetch(s.url);
    assert.equal(denied.status, 429);
    assert.equal(denied.headers.get("x-ratelimit-limit"), "1"); // the strict rule's numbers
  } finally {
    await s.close();
  }
});

test("headers describe the tightest rule when everything is allowed", async () => {
  const s = await composeServer({
    rulesFor: (store) => [
      {
        limiter: new RateLimiter({
          name: "ip",
          capacity: 100,
          refillPerSec: 1,
          store,
        }),
        keyGenerator: () => "k",
      },
      {
        limiter: new RateLimiter({
          name: "user",
          capacity: 3,
          refillPerSec: 1,
          store,
        }),
        keyGenerator: () => "k",
      },
    ],
  });
  try {
    const r = await fetch(s.url);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-ratelimit-limit"), "3");
    assert.equal(r.headers.get("x-ratelimit-remaining"), "2");
  } finally {
    await s.close();
  }
});

test("checking stops at the first denial, so later rules spend nothing", async () => {
  const store = new MemoryStore({ cleanupIntervalMs: 0 });
  const strict = new RateLimiter({
    name: "strict",
    capacity: 1,
    refillPerSec: 0.001,
    store,
  });
  const loose = new RateLimiter({
    name: "loose",
    capacity: 3,
    refillPerSec: 0.001,
    store,
  });
  const mw = rateLimit({
    rules: [
      { limiter: strict, keyGenerator: () => "k" },
      { limiter: loose, keyGenerator: () => "k" },
    ],
  });
  const res = () => ({ setHeader() {}, end() {}, statusCode: 0 });

  await mw({}, res(), () => {}); // allowed: strict 0 left, loose 2 left
  await mw({}, res(), () => {}); // denied by strict; loose must be untouched
  await mw({}, res(), () => {}); // denied again

  const probe = await loose.check("k"); // consumes one more
  assert.equal(probe.remaining, 1); // 3 - 1 (first request) - 1 (probe)
  await store.close();
});

test("a rule whose key is null is skipped (e.g. anonymous users)", async () => {
  const s = await composeServer({
    rulesFor: (store) => [
      {
        limiter: new RateLimiter({
          name: "user",
          capacity: 1,
          refillPerSec: 0.001,
          store,
        }),
        keyGenerator: () => null, // anonymous: rule doesn't apply
      },
      {
        limiter: new RateLimiter({
          name: "ip",
          capacity: 2,
          refillPerSec: 0.001,
          store,
        }),
        keyGenerator: () => "ip1",
      },
    ],
  });
  try {
    assert.equal((await fetch(s.url)).status, 200);
    assert.equal((await fetch(s.url)).status, 200); // would be 429 if the user rule applied
    assert.equal((await fetch(s.url)).status, 429); // ip rule still enforced
  } finally {
    await s.close();
  }
});

test("if every rule is skipped the request just passes", async () => {
  const s = await composeServer({
    rulesFor: (store) => [
      {
        limiter: new RateLimiter({
          name: "u",
          capacity: 1,
          refillPerSec: 1,
          store,
        }),
        keyGenerator: () => null,
      },
    ],
  });
  try {
    const r = await fetch(s.url);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-ratelimit-limit"), null);
  } finally {
    await s.close();
  }
});

test("rules can have their own cost, defaulting to the top-level cost", async () => {
  const store = new MemoryStore({ cleanupIntervalMs: 0 });
  const heavy = new RateLimiter({
    name: "heavy",
    capacity: 10,
    refillPerSec: 0.001,
    store,
  });
  const light = new RateLimiter({
    name: "light",
    capacity: 10,
    refillPerSec: 0.001,
    store,
  });
  const mw = rateLimit({
    cost: 1,
    rules: [
      { limiter: heavy, keyGenerator: () => "k", cost: 4 },
      { limiter: light, keyGenerator: () => "k" },
    ],
  });
  await mw({}, { setHeader() {}, end() {} }, () => {});
  assert.equal((await heavy.check("k", 1)).remaining, 5); // 10 - 4 - 1
  assert.equal((await light.check("k", 1)).remaining, 8); // 10 - 1 - 1
  await store.close();
});

test("an error in any rule triggers the failure policy", async () => {
  const broken = {
    check: async () => {
      throw new Error("boom");
    },
  };
  const errors = [];
  const s = await serve((now) => {
    const store = new MemoryStore({ now, cleanupIntervalMs: 0 });
    const mw = rateLimit({
      rules: [
        {
          limiter: new RateLimiter({
            name: "a",
            capacity: 5,
            refillPerSec: 1,
            store,
          }),
          keyGenerator: () => "k",
        },
        { limiter: broken, keyGenerator: () => "k" },
      ],
      failOpen: false,
      onError: (e) => errors.push(e.message),
    });
    return (req, res) => mw(req, res, () => ok(res));
  });
  try {
    assert.equal((await fetch(s.url)).status, 503);
    assert.deepEqual(errors, ["boom"]);
  } finally {
    await s.close();
  }
});

test("rateLimit rejects ambiguous or empty configuration", () => {
  const l = new RateLimiter({ capacity: 1, refillPerSec: 1 });
  assert.throws(
    () => rateLimit({ limiter: l, rules: [{ limiter: l }] }),
    TypeError,
  );
  assert.throws(() => rateLimit({ rules: [] }), TypeError);
  assert.throws(() => rateLimit({ rules: [{}] }), TypeError);
});

// ---------- per-route limits ----------

test("different routes can have independent limits", async () => {
  const s = await serve((now) => {
    const store = new MemoryStore({ now, cleanupIntervalMs: 0 });
    const loose = rateLimit({
      now,
      limiter: new RateLimiter({
        name: "api",
        ...rate({ limit: 100, per: "minute" }),
        store,
      }),
    });
    const strictLogin = rateLimit({
      now,
      limiter: new RateLimiter({
        name: "login",
        ...rate({ limit: 2, per: "minute" }),
        store,
      }),
    });
    return (req, res) => {
      const mw = req.url === "/login" ? strictLogin : loose;
      mw(req, res, () => ok(res));
    };
  });
  try {
    assert.equal((await fetch(`${s.url}/login`)).status, 200);
    assert.equal((await fetch(`${s.url}/login`)).status, 200);
    assert.equal((await fetch(`${s.url}/login`)).status, 429);
    assert.equal((await fetch(`${s.url}/data`)).status, 200); // unaffected by login limit
  } finally {
    await s.close();
  }
});
