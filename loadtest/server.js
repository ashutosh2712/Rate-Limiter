"use strict";

/**
 * Standalone server for load tests. Plain `http`, no Express, so it measures
 * the limiter rather than a framework.
 *
 * Env:
 *   PORT=3000   STORE=memory|redis   REDIS_URL=redis://127.0.0.1:6379
 *   CAPACITY=100   REFILL=0.0001 (tokens/sec)   LIMITER_NAME=load
 *   NOLIMIT=1   -> no limiter at all (baseline for measuring overhead)
 *
 * The key is the `x-client` request header (default "anon").
 * GET /__stats returns server-side counters: the ground truth for how many
 * requests actually reached the handler.
 */

const http = require("node:http");
const { RateLimiter, MemoryStore, RedisStore, rateLimit } = require("../src");
const { waitForRedis } = require("./util");

const PORT = Number(process.env.PORT || 3000);
const STORE = process.env.STORE || "memory";
const CAPACITY = Number(process.env.CAPACITY || 100);
const REFILL = Number(process.env.REFILL || 0.0001);
const NAME = process.env.LIMITER_NAME || "load";
const NOLIMIT = process.env.NOLIMIT === "1";

const stats = {
  pid: process.pid,
  store: NOLIMIT ? "none" : STORE,
  admitted: 0,
  limited: 0,
  errors: 0,
};

let store;
let ready = Promise.resolve();
if (STORE === "redis") {
  const Redis = require("ioredis");
  const client = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379", {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 500,
  });
  client.on("error", () => {}); // surfaces via stats.errors
  ready = waitForRedis(client); // don't accept traffic before Redis is connected
  store = new RedisStore({ client, keyPrefix: "rl-load:", closeClient: true });
} else {
  store = new MemoryStore();
}

const mw = NOLIMIT
  ? null
  : rateLimit({
      limiter: new RateLimiter({
        name: NAME,
        capacity: CAPACITY,
        refillPerSec: REFILL,
        store,
      }),
      keyGenerator: (req) => req.headers["x-client"] || "anon",
      onError: () => {
        stats.errors++;
      }, // failOpen (default): these requests are admitted
    });

const server = http.createServer((req, res) => {
  if (req.url === "/__stats") {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify(stats));
  }
  res.on("finish", () => {
    if (res.statusCode === 429) stats.limited++;
  });

  const handler = () => {
    stats.admitted++;
    res.statusCode = 200;
    res.end("ok");
  };
  return mw ? mw(req, res, handler) : handler();
});

ready
  .then(() =>
    server.listen(PORT, "127.0.0.1", () => {
      console.log(
        `[${process.pid}] listening on :${PORT} store=${stats.store} capacity=${CAPACITY} refill=${REFILL}/s`,
      );
    }),
  )
  .catch((err) => {
    console.error(`[${process.pid}] startup failed: ${err.message}`);
    process.exit(1);
  });

async function shutdown() {
  server.closeAllConnections();
  server.close();
  await store.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
