"use strict";

// Integration tests: need `npm i -D ioredis` and a running Redis
// (docker compose up -d). Override the address with REDIS_URL.
// If either is missing the tests are SKIPPED, not failed.

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const { RedisStore, RateLimiter, rateLimit } = require("../src");

let Redis = null;
try {
  Redis = require("ioredis");
} catch {
  /* not installed */
}

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const PREFIX = `rltest:${crypto.randomUUID()}:`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const clientOptions = {
  lazyConnect: true,
  enableOfflineQueue: false, // fail fast when Redis is down
  maxRetriesPerRequest: 1,
  connectTimeout: 500,
  retryStrategy: () => null, // don't retry forever in tests
};

function newClient(url = REDIS_URL) {
  const c = new Redis(url, clientOptions);
  c.on("error", () => {}); // errors surface through rejected commands
  return c;
}

// ---- Needs ioredis only: fail-open behaviour with Redis unreachable ----

describe(
  "RedisStore with an unreachable Redis",
  { skip: !Redis && "ioredis not installed" },
  () => {
    async function serverWith(failOpen) {
      const client = newClient("redis://127.0.0.1:1"); // nothing listens here
      const limiter = new RateLimiter({
        capacity: 1,
        refillPerSec: 1,
        store: new RedisStore({ client, timeoutMs: 200 }),
      });
      const mw = rateLimit({ limiter, failOpen });
      const server = http.createServer((req, res) =>
        mw(req, res, () => {
          res.statusCode = 200;
          res.end("ok");
        }),
      );
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      return {
        url: `http://127.0.0.1:${server.address().port}`,
        close: async () => {
          server.closeAllConnections();
          await new Promise((r) => server.close(r));
          client.disconnect();
        },
      };
    }

    it("fails fast (does not hang) and the middleware fails OPEN", async () => {
      const s = await serverWith(true);
      try {
        const started = Date.now();
        const res = await fetch(s.url);
        assert.equal(res.status, 200);
        assert.ok(
          Date.now() - started < 1000,
          "request must not hang on a dead Redis",
        );
      } finally {
        await s.close();
      }
    });

    it("failOpen:false returns 503", async () => {
      const s = await serverWith(false);
      try {
        assert.equal((await fetch(s.url)).status, 503);
      } finally {
        await s.close();
      }
    });
  },
);

// ---- Needs ioredis AND a running Redis ----

describe(
  "RedisStore (real Redis)",
  { skip: !Redis && "ioredis not installed" },
  () => {
    let client;
    let available = false;
    const stores = [];

    const newStore = (c = client, opts = {}) =>
      new RedisStore({ client: c, keyPrefix: PREFIX, ...opts });
    const guard = (fn) => async (t) => {
      if (!available) return t.skip(`Redis not reachable at ${REDIS_URL}`);
      return fn(t);
    };

    before(async () => {
      client = newClient();
      try {
        await client.connect();
        await client.ping();
        available = true;
      } catch {
        client.disconnect();
      }
    });

    after(async () => {
      if (!available) return;
      const keys = [];
      for await (const batch of client.scanStream({
        match: `${PREFIX}*`,
        count: 100,
      }))
        keys.push(...batch);
      if (keys.length) await client.del(...keys);
      for (const s of stores) await s.close();
      await client.quit();
    });

    it(
      "allows a burst up to capacity, then denies with a sensible retryAfterMs",
      guard(async () => {
        const store = newStore();
        const cfg = { capacity: 3, refillPerSec: 1 };
        const results = [];
        for (let i = 0; i < 4; i++)
          results.push(await store.consume("burst", cfg));

        assert.deepEqual(
          results.slice(0, 3).map((r) => r.allowed),
          [true, true, true],
        );
        assert.deepEqual(
          results.slice(0, 3).map((r) => r.remaining),
          [2, 1, 0],
        );
        assert.equal(results[3].allowed, false);
        assert.ok(
          results[3].retryAfterMs > 0 && results[3].retryAfterMs <= 1000,
          `got ${results[3].retryAfterMs}`,
        );
      }),
    );

    it(
      "keeps keys independent",
      guard(async () => {
        const store = newStore();
        const cfg = { capacity: 1, refillPerSec: 0.001 };
        assert.equal((await store.consume("alice", cfg)).allowed, true);
        assert.equal((await store.consume("alice", cfg)).allowed, false);
        assert.equal((await store.consume("bob", cfg)).allowed, true);
      }),
    );

    it(
      "refills over real time",
      guard(async () => {
        const store = newStore();
        const cfg = { capacity: 1, refillPerSec: 5 }; // one token per 200ms
        assert.equal((await store.consume("refill", cfg)).allowed, true);
        assert.equal((await store.consume("refill", cfg)).allowed, false);
        await sleep(300);
        assert.equal((await store.consume("refill", cfg)).allowed, true);
      }),
    );

    it(
      "supports weighted cost",
      guard(async () => {
        const store = newStore();
        const cfg = { capacity: 10, refillPerSec: 0.001 };
        assert.equal(
          (await store.consume("cost", { ...cfg, cost: 7 })).allowed,
          true,
        );
        assert.equal(
          (await store.consume("cost", { ...cfg, cost: 7 })).allowed,
          false,
        );
        assert.equal(
          (await store.consume("cost", { ...cfg, cost: 3 })).allowed,
          true,
        );
      }),
    );

    it(
      "RACE: 100 concurrent requests on one connection admit exactly `capacity`",
      guard(async () => {
        const store = newStore();
        const cfg = { capacity: 10, refillPerSec: 0.001 };
        const results = await Promise.all(
          Array.from({ length: 100 }, () => store.consume("race1", cfg)),
        );
        assert.equal(results.filter((r) => r.allowed).length, 10);
      }),
    );

    it(
      'RACE: two independent clients ("app servers") together admit exactly `capacity`',
      guard(async () => {
        const other = newClient();
        await other.connect();
        try {
          const a = newStore(client);
          const b = newStore(other);
          const cfg = { capacity: 10, refillPerSec: 0.001 };
          const calls = Array.from({ length: 200 }, (_, i) =>
            (i % 2 ? a : b).consume("race2", cfg),
          );
          const results = await Promise.all(calls);
          assert.equal(results.filter((r) => r.allowed).length, 10);
        } finally {
          await other.quit();
        }
      }),
    );

    it(
      "sets a TTL so idle keys disappear",
      guard(async () => {
        const store = newStore();
        const res = await store.consume("ttl", {
          capacity: 2,
          refillPerSec: 1,
        });
        const ttl = await client.pttl(`${PREFIX}ttl`);
        assert.ok(ttl > 0, "key must have an expiry");
        assert.ok(
          ttl <= res.resetMs + 1000,
          `ttl ${ttl} should not exceed resetMs+1000`,
        );
      }),
    );

    it(
      "applies a changed config immediately (capacity is re-read on every call)",
      guard(async () => {
        const store = newStore();
        await store.consume("cfg", { capacity: 10, refillPerSec: 0.001 }); // 9 left
        const res = await store.consume("cfg", {
          capacity: 2,
          refillPerSec: 0.001,
        });
        assert.equal(res.allowed, true);
        assert.equal(res.remaining, 1); // clamped to the new capacity (2) before spending
      }),
    );

    it(
      "END TO END: two limiter instances sharing Redis enforce ONE limit",
      guard(async () => {
        const other = newClient();
        await other.connect();
        try {
          const make = (c) =>
            new RateLimiter({
              name: "e2e",
              capacity: 2,
              refillPerSec: 0.001,
              store: new RedisStore({ client: c, keyPrefix: PREFIX }),
            });
          const serverA = make(client);
          const serverB = make(other);

          assert.equal((await serverA.check("user1")).allowed, true);
          assert.equal((await serverB.check("user1")).allowed, true);
          assert.equal((await serverA.check("user1")).allowed, false); // B's request counted too
        } finally {
          await other.quit();
        }
      }),
    );
  },
);
