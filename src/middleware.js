"use strict";

/**
 * Default key: the client IP.
 *
 * Express sets req.ip. Behind a reverse proxy / load balancer it is the
 * PROXY's address unless you configure `app.set('trust proxy', ...)`,
 * otherwise every user shares one bucket. Never read X-Forwarded-For
 * yourself without a trusted proxy: clients can spoof it.
 */
function defaultKeyGenerator(req) {
  return req.ip || (req.socket && req.socket.remoteAddress) || undefined;
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

/**
 * Call the observer hook. A broken metrics hook must NEVER break or slow a
 * request, so errors (sync or async) are swallowed.
 */
function notify(onDecision, event) {
  if (!onDecision) return;
  try {
    const r = onDecision(event);
    if (r && typeof r.catch === "function") r.catch(() => {});
  } catch {
    /* ignore */
  }
}

function isLimiterLike(l) {
  return typeof l === "function" || (l && typeof l.check === "function");
}

/** Merge top-level defaults into each rule; validate. */
function compileRules({ limiter, rules, keyGenerator, cost }) {
  if (limiter && rules) {
    throw new TypeError(
      "rateLimit: pass either `limiter` or `rules`, not both",
    );
  }
  const list = rules || (limiter ? [{ limiter }] : []);
  if (list.length === 0) {
    throw new TypeError(
      "rateLimit: a limiter (or a non-empty `rules` array) is required",
    );
  }
  return list.map((r) => {
    if (!isLimiterLike(r.limiter)) {
      throw new TypeError(
        "rateLimit: each rule needs a limiter (a RateLimiter or a (req) => RateLimiter function)",
      );
    }
    return {
      limiter: r.limiter,
      keyGenerator: r.keyGenerator || keyGenerator,
      cost: r.cost ?? cost,
    };
  });
}

/**
 * Create rate limiting middleware. Works with Express (and anything else
 * using the (req, res, next) signature) because it only touches Node's
 * core req/res API.
 *
 * Single rule:   rateLimit({ limiter })
 * Tiers:         rateLimit({ limiter: byTier({...}) })       (limiter may be a (req) => limiter function)
 * Several rules: rateLimit({ rules: [{ limiter, keyGenerator, cost }, ...] })
 *
 * With several rules, ALL must allow the request. Rules are checked in
 * order and checking stops at the first denial, so list the strictest first.
 * A rule whose keyGenerator returns null is skipped (e.g. a per-user rule
 * for anonymous requests). Returning undefined is treated as a bug (error).
 *
 * @param {object} opts
 * @param {object|Function} [opts.limiter]
 * @param {Array<{limiter, keyGenerator?, cost?}>} [opts.rules]
 * @param {(req) => string|null|Promise<string|null>} [opts.keyGenerator]  Default key for rules. Default: client IP
 * @param {number|((req) => number)} [opts.cost=1]               Tokens per request
 * @param {(req) => boolean} [opts.skip]                         Return true to bypass (health checks...). Must be sync
 * @param {boolean} [opts.failOpen=true]                         If a limiter errors: allow (true) or 503 (false)
 * @param {(err: Error) => void} [opts.onError]                  Called when a limiter throws (log it!)
 * @param {(event: DecisionEvent) => void} [opts.onDecision]     Observer for metrics/logging, called once per request:
 *     { outcome: 'allowed'|'blocked'|'error'|'skipped', durationMs, req,
 *       limit, remaining, retryAfterMs   (allowed/blocked),
 *       error, failedOpen                (error) }
 *     Exceptions thrown by the hook are swallowed.
 * @param {(req, res, next, result) => void} [opts.onLimited]    Custom 429 response
 * @param {boolean} [opts.headers=true]                          Send X-RateLimit-* headers
 * @param {() => number} [opts.now]                              Clock (ms), used for the Reset header
 */
function rateLimit({
  limiter,
  rules,
  keyGenerator = defaultKeyGenerator,
  cost = 1,
  skip,
  failOpen = true,
  onError,
  onDecision,
  onLimited,
  headers = true,
  now = Date.now,
}) {
  const compiled = compileRules({ limiter, rules, keyGenerator, cost });

  return async function rateLimitMiddleware(req, res, next) {
    if (skip && skip(req)) {
      notify(onDecision, { outcome: "skipped", durationMs: 0, req });
      return next();
    }

    // Only the limiter work is inside try/catch. Errors thrown later by
    // next() must NOT be mistaken for limiter failures.
    const startedAt = performance.now();
    let outcome = null; // the result we report: the denial, else the tightest allowance
    try {
      for (const rule of compiled) {
        const key = await rule.keyGenerator(req);
        if (key === null) continue; // rule explicitly not applicable

        const l =
          typeof rule.limiter === "function" ? rule.limiter(req) : rule.limiter;
        const c = typeof rule.cost === "function" ? rule.cost(req) : rule.cost;
        const result = await l.check(key, c);

        if (!result.allowed) {
          outcome = result;
          break;
        }
        if (!outcome || result.remaining < outcome.remaining) outcome = result;
      }
    } catch (err) {
      if (onError) onError(err);
      notify(onDecision, {
        outcome: "error",
        failedOpen: failOpen,
        error: err,
        durationMs: performance.now() - startedAt,
        req,
      });
      if (failOpen) return next();
      return sendJson(res, 503, { error: "Service Unavailable" });
    }

    const durationMs = performance.now() - startedAt;

    if (!outcome) {
      notify(onDecision, { outcome: "skipped", durationMs, req }); // every rule was skipped
      return next();
    }

    notify(onDecision, {
      outcome: outcome.allowed ? "allowed" : "blocked",
      limit: outcome.limit,
      remaining: outcome.remaining,
      retryAfterMs: outcome.retryAfterMs,
      durationMs,
      req,
    });

    if (headers) {
      res.setHeader("X-RateLimit-Limit", String(outcome.limit));
      res.setHeader("X-RateLimit-Remaining", String(outcome.remaining));
      // Unix time (seconds) at which the bucket is full again
      res.setHeader(
        "X-RateLimit-Reset",
        String(Math.ceil((now() + outcome.resetMs) / 1000)),
      );
    }

    if (outcome.allowed) return next();

    // Retry-After is in whole seconds; round up so clients never retry too early.
    const retryAfterSec = Math.max(1, Math.ceil(outcome.retryAfterMs / 1000));
    res.setHeader("Retry-After", String(retryAfterSec));

    if (onLimited) return onLimited(req, res, next, outcome);

    return sendJson(res, 429, {
      error: "Too Many Requests",
      retryAfterSeconds: retryAfterSec,
    });
  };
}

module.exports = { rateLimit, defaultKeyGenerator };
