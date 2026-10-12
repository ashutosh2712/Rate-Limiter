# rate-limiter

A token bucket rate limiter for Node.js, with an in-memory store, an atomic Redis store, Express-compatible middleware, per-route and per-tier rules, and built-in metrics. No runtime dependencies (Redis support needs `ioredis`).

Tested on Node 22. Requires Node 18+.

## Quick start

```js
const express = require("express");
const { RateLimiter, rateLimit, rate } = require("./src");

const app = express();
app.set("trust proxy", 1); // if behind a proxy/load balancer, see "Production checklist"

// 100 requests/minute sustained, bursts of up to 20
const limiter = new RateLimiter({
  ...rate({ limit: 100, per: "minute", burst: 20 }),
});

app.use(rateLimit({ limiter }));
app.get("/", (req, res) => res.json({ ok: true }));
app.listen(3000);
```

The middleware only uses Node's core `req`/`res` API (`setHeader`, `statusCode`, `end`), so it works in Express and in a bare `http` server.

## How it works

Each client (identified by a key such as an IP or user id) has a bucket holding up to `capacity` tokens. Tokens refill continuously at `refillPerSec`. Each request spends one token (or `cost` tokens); with no token available, the request is rejected.

- **Burst, then steady rate.** A client with `capacity: 10, refillPerSec: 1` can send 10 requests at once, then about 1 per second.
- **Lazy refill.** Tokens are computed from elapsed time when a request arrives. There are no timers and no background work.
- **Two numbers of state per key:** `tokens` and the last refill time.

## Configuration reference

### `rate({ limit, per, burst })`

Converts a readable rule into bucket parameters.

| Option  | Meaning                                                                |
| ------- | ---------------------------------------------------------------------- |
| `limit` | Requests allowed per window (sustained rate)                           |
| `per`   | `'second'`, `'minute'`, `'hour'`, `'day'`, or a window in milliseconds |
| `burst` | Optional bucket size. Defaults to `limit`                              |

```js
rate({ limit: 100, per: "minute" }); // { capacity: 100, refillPerSec: 1.666... }
rate({ limit: 5, per: 15 * 60_000 }); // 5 per 15 minutes
rate({ limit: 100, per: "minute", burst: 10 }); // sustained 100/min, but at most 10 at once
```

### `new RateLimiter({ capacity, refillPerSec, name, store })`

| Option                     | Meaning                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `capacity`, `refillPerSec` | The rule (usually spread in from `rate()`)                                                                       |
| `name`                     | Namespace for this limiter's keys. **Give every limiter that shares a store a unique name.** Default `'default'` |
| `store`                    | `MemoryStore` (default) or `RedisStore`                                                                          |

`await limiter.check(key, cost = 1)` returns `{ allowed, remaining, retryAfterMs, resetMs, limit }`.

### `rateLimit(options)` (middleware)

| Option         | Default   | Meaning                                                                                                  |
| -------------- | --------- | -------------------------------------------------------------------------------------------------------- |
| `limiter`      |           | A `RateLimiter`, or a `(req) => RateLimiter` function (used by tiers)                                    |
| `rules`        |           | Array of `{ limiter, keyGenerator?, cost? }` to enforce several limits at once. Use instead of `limiter` |
| `keyGenerator` | client IP | `(req) => string`. Return `null` to skip a rule for this request                                         |
| `cost`         | `1`       | A number, or `(req) => number`                                                                           |
| `skip`         |           | Sync `(req) => boolean`. `true` bypasses limiting (health checks, metrics)                               |
| `failOpen`     | `true`    | If the limiter errors: allow the request (`true`) or respond `503` (`false`)                             |
| `onError`      |           | `(err) => void`, called when the limiter throws. Log it                                                  |
| `onDecision`   |           | Observer hook for metrics, see below                                                                     |
| `onLimited`    |           | `(req, res, next, result)`: custom 429 response                                                          |
| `headers`      | `true`    | Send `X-RateLimit-*` headers                                                                             |

### Per-route limits

Use a different middleware on each route. Limiters can share one store as long as their `name`s differ.

```js
const store = new MemoryStore();
const api = new RateLimiter({
  store,
  name: "api",
  ...rate({ limit: 100, per: "minute" }),
});
const login = new RateLimiter({
  store,
  name: "login",
  ...rate({ limit: 5, per: 15 * 60_000 }),
});

app.use(rateLimit({ limiter: api }));
app.post("/login", rateLimit({ limiter: login, failOpen: false }), handler);
```

### Tiers

```js
const { byTier } = require("./src");

const limiter = byTier({
  tiers: {
    free: rate({ limit: 60, per: "minute" }),
    pro: rate({ limit: 600, per: "minute" }),
  },
  getTier: (req) => req.user?.plan, // from your auth layer, never from a client header
  defaultTier: "free", // used for unknown or missing tiers
});
app.use(rateLimit({ limiter, keyGenerator: (req) => req.user?.id ?? req.ip }));
```

### Composing several rules

All rules must allow the request. Rules are checked in order and checking stops at the first denial, so **list the strictest first**.

```js
app.use(
  rateLimit({
    rules: [
      { limiter: perUser, keyGenerator: (req) => req.user?.id ?? null }, // null: anonymous, rule skipped
      { limiter: perIp, keyGenerator: (req) => req.ip },
    ],
  }),
);
```

## HTTP behavior

| Response                                | When                                 |
| --------------------------------------- | ------------------------------------ |
| Pass-through with headers               | Request allowed                      |
| `429 Too Many Requests` + `Retry-After` | Over the limit                       |
| `503`                                   | Limiter error with `failOpen: false` |

| Header                  | Meaning                                                    |
| ----------------------- | ---------------------------------------------------------- |
| `X-RateLimit-Limit`     | Bucket capacity of the rule that applies                   |
| `X-RateLimit-Remaining` | Whole tokens left                                          |
| `X-RateLimit-Reset`     | Unix time in **seconds** when the bucket is full again     |
| `Retry-After`           | On 429 only: whole seconds to wait, rounded up, at least 1 |

With several rules, headers describe the rule that denied, or the tightest rule when all allow.

## Stores

### `MemoryStore`

State lives in one process. Fast, with no dependencies, but **each process has its own counts**: three servers allow three times the limit. Idle buckets are swept on a timer (`cleanupIntervalMs`, default 60s). Use it for development, tests, and single-process deployments.

### `RedisStore`

```js
const Redis = require("ioredis");
const { RedisStore } = require("./src");

const client = new Redis(process.env.REDIS_URL, {
  enableOfflineQueue: false, // fail fast when Redis is down, instead of queueing requests
  maxRetriesPerRequest: 1,
  connectTimeout: 500,
});
const store = new RedisStore({
  client,
  keyPrefix: "myapp:rl:",
  timeoutMs: 200,
});
```

- **Atomic.** The whole read, refill and spend sequence runs as one Lua script, so concurrent requests from many servers cannot over-admit. This is verified by `npm run load:correctness:redis`.
- **Redis supplies the clock** (`TIME` inside the script), so clock skew between app servers cannot grant extra tokens.
- **Keys expire** shortly after the bucket would be full again, so idle users cost no memory.
- **Config is read on every call**, so changing a limit takes effect immediately.
- **Every check has a timeout** (`timeoutMs`, default 200ms) so a slow Redis cannot hang requests. A timeout counts as a limiter error and your `failOpen` policy applies.
- **Wait for the connection before serving.** With `enableOfflineQueue: false`, commands sent before the client is `ready` are rejected. See `loadtest/util.js` (`waitForRedis`).

## Metrics

```js
const { createMetrics } = require("./src");
const metrics = createMetrics();

app.use(
  rateLimit({
    limiter,
    skip: (req) => req.path === "/metrics",
    onDecision: metrics.record,
  }),
);
app.get("/metrics", (req, res) =>
  res.type("text/plain").send(metrics.toPrometheus()),
);
```

`onDecision(event)` is called once per request with:

| `outcome`            | Extra fields                                              |
| -------------------- | --------------------------------------------------------- |
| `allowed`, `blocked` | `limit`, `remaining`, `retryAfterMs`, `durationMs`, `req` |
| `error`              | `error`, `failedOpen`, `durationMs`, `req`                |
| `skipped`            | `req`                                                     |

Exceptions thrown by the hook are swallowed, so metrics code can never break a request. You can pass your own function instead of `createMetrics` to log events or feed another system.

`createMetrics()` exposes `record`, `snapshot()`, `toPrometheus({ prefix })` and `reset()`, and exports:

- `ratelimit_requests_total{outcome="allowed|blocked|error|skipped"}`
- `ratelimit_check_duration_seconds` (histogram)

Metrics are deliberately **not labelled by key, user or IP**, because one series per user overwhelms a metrics backend. **Alert on a rising `error` count**: with `failOpen: true`, a broken limiter looks like healthy traffic.

## Production checklist

- **Behind a proxy or load balancer?** `req.ip` is the proxy's address unless you set `app.set('trust proxy', <hops>)`, and everyone then shares one bucket. Never parse `X-Forwarded-For` yourself.
- **Choose fail-open or fail-closed per route.** Open (default) for general APIs. Closed (`failOpen: false`) for login, password reset and other abuse-sensitive routes.
- **Never take the tier from a client-controlled header.** Derive it from the authenticated session.
- **Put the limiter before expensive middleware** (body parsing, auth DB lookups).
- **Combine per-user limits with a generous per-IP backstop**, so rotating credentials doesn't evade limits. Keep the IP limit loose, because offices and mobile carriers share IPs.
- **Don't use unbounded user-supplied strings as keys** (for example a raw API key header) without hashing them, since they become Redis key names.
- **Run Redis with a password and don't expose it publicly.** The included `docker-compose.yml` binds to localhost for this reason.
- **Keep an edge limit too** (nginx, CDN, cloud WAF). Blocked requests still cost one store round trip each, so floods should be absorbed before they reach this limiter.

## Testing

```bash
npm test                      # unit + HTTP tests; Redis tests skip if Redis/ioredis are unavailable
docker compose up -d          # start Redis to enable the Redis integration tests
npm run load:correctness      # multi-process test with the in-memory store (shows over-admission)
npm run load:correctness:redis# the same test on Redis: must admit exactly the capacity
npm run load:store            # limiter-only throughput and latency, in-memory
npm run load:store:redis      # same on Redis
```

`loadtest/correctness.js` starts several server processes, sends all traffic for one key at them, and sums how many requests each admitted. In-memory it admits `processes x capacity` (the problem). On Redis it admits exactly `capacity`.

**Measured Redis cost** (`npm run load:store:redis`, one laptop with Redis in Docker, 100 checks in flight, 1000 keys, all allowed):

| Metric                  | Result                   |
| ----------------------- | ------------------------ |
| Throughput              | about 153,000 checks/sec |
| Latency p50 / p95 / p99 | 0.56 / 1.20 / 1.73 ms    |

These latencies include queueing behind other in-flight checks. A single check on an idle connection is typically faster. Your hardware and network will differ, so run the benchmark yourself. Over a real network, expect the round trip to Redis to dominate.

## Project layout

```
src/
  token-bucket.js     core algorithm, injectable clock
  memory-store.js     in-process store with idle cleanup
  redis-store.js      Redis store (ioredis)
  lua/token-bucket.lua  atomic bucket script
  rate-limiter.js     RateLimiter: rule + store + key namespacing
  rate.js             rate() helper
  tiers.js            byTier()
  middleware.js       rateLimit()
  metrics.js          createMetrics()
  index.js            exports
test/                 unit, HTTP and Redis integration tests
loadtest/             multi-process correctness test, limiter benchmark, load-test server
example/server.js     Express app using everything
```

## Known limitations

- **Composed rules are not atomic.** If an earlier rule allows and a later rule denies, the earlier rule's token is already spent. Listing the strictest rule first minimizes this.
- **In-memory state is per process**, with no cap on the number of keys. Use Redis for anything multi-process or exposed to untrusted traffic.
- **Redis Cluster is untested.** The script touches a single key per call, so it should work.
- **One algorithm.** Token bucket only: no sliding window or leaky bucket.

## Roadmap

- [x] TokenBucket core with injectable clock
- [x] In-memory store with cleanup
- [x] Express-compatible middleware (429, `Retry-After`, `X-RateLimit-*`)
- [x] Rules: per-route, tiers, composed
- [x] Redis store with atomic Lua script
- [x] Load and correctness tests
- [x] Metrics hooks and Prometheus output
- [ ] Atomic multi-rule Lua script
- [ ] Sliding window counter as an alternative algorithm
