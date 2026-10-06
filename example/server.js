"use strict";

// Run: npm install --save-dev express && node example/server.js
const express = require("express");
const { RateLimiter, MemoryStore, rateLimit, rate, byTier } = require("../src");
const { RedisStore } = require("../src/redis-store");

const app = express();
// Behind a proxy/load balancer? Trust the right number of hops so req.ip is the real client.
// app.set('trust proxy', 1);

// ONE store shared by every limiter. Each limiter's `name` keeps its keys apart.
//const store = new MemoryStore();
const store = new RedisStore({
  client: new Redis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  }),
});

// Fake auth for the demo. In real code req.user comes from your auth layer.
app.use((req, res, next) => {
  const token = req.get("authorization"); // "Bearer free-alice", "Bearer pro-bob"
  if (token) {
    const [, id] = token.split(" ");
    req.user = { id, plan: id.startsWith("pro-") ? "pro" : "free" };
  }
  next();
});

const ipKey = (req) => req.ip;
const userKey = (req) => (req.user ? req.user.id : null); // null => rule skipped for anonymous

// 1) Global: per-user limit chosen by plan, plus a generous per-IP backstop.
//    Strictest rule first, so a denial spends as few tokens as possible.
const perPlan = byTier({
  store,
  name: "api",
  tiers: {
    free: rate({ limit: 60, per: "minute", burst: 10 }),
    pro: rate({ limit: 600, per: "minute", burst: 50 }),
  },
  getTier: (req) => req.user?.plan,
  defaultTier: "free",
});
const perIp = new RateLimiter({
  store,
  name: "ip",
  ...rate({ limit: 300, per: "minute" }),
});

app.use(
  rateLimit({
    skip: (req) => req.path === "/health",
    onError: (err) => console.error("rate limiter error:", err),
    rules: [
      { limiter: perPlan, keyGenerator: userKey },
      { limiter: perIp, keyGenerator: ipKey },
    ],
  }),
);

// 2) Per-route: login is brute-force bait, so 5 attempts per 15 minutes per IP.
//    Sensitive endpoint => fail CLOSED if the limiter is unavailable.
const loginLimit = rateLimit({
  failOpen: false,
  onError: (err) => console.error("login limiter error:", err),
  limiter: new RateLimiter({
    store,
    name: "login",
    ...rate({ limit: 5, per: 15 * 60_000 }),
  }),
});

app.get("/health", (req, res) => res.send("ok"));
app.get("/", (req, res) =>
  res.json({ hello: "world", user: req.user ?? null }),
);
app.post("/login", loginLimit, (req, res) => res.json({ ok: true }));

const server = app.listen(3000, () => console.log("listening on :3000"));
process.on("SIGTERM", async () => {
  await store.close();
  server.close();
});
