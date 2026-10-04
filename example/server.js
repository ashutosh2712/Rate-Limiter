"use strict";

// Run:  node example/server.js
const express = require("express");
const { RateLimiter, rateLimit } = require("../src");

const app = express();

// Behind a proxy/load balancer? Tell Express how many hops to trust so
// req.ip is the real client. Leave unset when exposed directly.
// app.set('trust proxy', 1);

// 10 requests burst, then 2 per second sustained
const limiter = new RateLimiter({ capacity: 10, refillPerSec: 2 });

app.use(
  rateLimit({
    limiter,
    skip: (req) => req.path === "/health",
    onError: (err) => console.error("rate limiter error:", err),
  }),
);

app.get("/health", (req, res) => res.send("ok"));
app.get("/", (req, res) => res.json({ hello: "world" }));

const server = app.listen(3000, () => console.log("listening on :3000"));

process.on("SIGTERM", async () => {
  await limiter.close();
  server.close();
});
