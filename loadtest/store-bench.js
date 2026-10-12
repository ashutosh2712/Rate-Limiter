"use strict";

/**
 * Measures the limiter alone (no HTTP): throughput and latency of check().
 *
 *   STORE=memory node loadtest/store-bench.js
 *   STORE=redis  node loadtest/store-bench.js
 *   OPS=50000 CONCURRENCY=100 KEYS=1000 STORE=redis node loadtest/store-bench.js
 *
 * Capacity is huge so every call is ALLOWED: this measures the full
 * read-refill-spend-write path, the expensive one.
 */

const { performance } = require("node:perf_hooks");
const { RateLimiter, MemoryStore, RedisStore } = require("../src");
const { waitForRedis } = require("./util");

const STORE = process.env.STORE || "memory";
const OPS = Number(process.env.OPS || 20000);
const CONCURRENCY = Number(process.env.CONCURRENCY || 100);
const KEYS = Number(process.env.KEYS || 1000);

async function main() {
  let store;
  if (STORE === "redis") {
    const Redis = require("ioredis");
    const client = new Redis(
      process.env.REDIS_URL || "redis://127.0.0.1:6379",
      {
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        connectTimeout: 500,
      },
    );
    client.on("error", () => {});
    await waitForRedis(client); // enableOfflineQueue:false rejects commands sent before 'ready'
    store = new RedisStore({
      client,
      keyPrefix: "rl-bench:",
      closeClient: true,
      timeoutMs: 2000,
    });
  } else {
    store = new MemoryStore({ cleanupIntervalMs: 0 });
  }
  const limiter = new RateLimiter({
    name: `bench-${Date.now()}`,
    capacity: 1e9,
    refillPerSec: 1e9,
    store,
  });

  // warm up (JIT, connection, script load)
  for (let i = 0; i < 200; i++) await limiter.check(`k${i % KEYS}`);

  const latencies = new Float64Array(OPS);
  let next = 0;
  let denied = 0;
  const started = performance.now();

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= OPS) return;
      const t0 = performance.now();
      const r = await limiter.check(`k${i % KEYS}`);
      latencies[i] = performance.now() - t0;
      if (!r.allowed) denied++;
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const seconds = (performance.now() - started) / 1000;

  const sorted = Float64Array.from(latencies).sort();
  const pct = (p) => sorted[Math.min(OPS - 1, Math.floor((p / 100) * OPS))];
  const fmt = (ms) => `${ms.toFixed(3)} ms`;

  console.log(
    `store=${STORE} ops=${OPS} concurrency=${CONCURRENCY} keys=${KEYS}`,
  );
  console.log(
    `throughput : ${Math.round(OPS / seconds).toLocaleString()} checks/sec`,
  );
  console.log(
    `latency    : p50=${fmt(pct(50))}  p95=${fmt(pct(95))}  p99=${fmt(pct(99))}  max=${fmt(sorted[OPS - 1])}`,
  );
  if (denied)
    console.log(
      `note       : ${denied} checks were denied (unexpected with this capacity)`,
    );
  await limiter.close();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
