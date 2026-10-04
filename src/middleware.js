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
 * Create rate limiting middleware. Works with Express (and anything else
 * using the (req, res, next) signature) because it only touches Node's
 * core req/res API.
 *
 * @param {object} opts
 * @param {import('./rate-limiter').RateLimiter} opts.limiter
 * @param {(req) => string|Promise<string>} [opts.keyGenerator]  Who to limit. Default: client IP
 * @param {number|((req) => number)} [opts.cost=1]               Tokens per request
 * @param {(req) => boolean} [opts.skip]                         Return true to bypass (health checks...). Must be sync
 * @param {boolean} [opts.failOpen=true]                         If the limiter errors: allow (true) or 503 (false)
 * @param {(err: Error) => void} [opts.onError]                  Called when the limiter throws (log it!)
 * @param {(req, res, next, result) => void} [opts.onLimited]    Custom 429 response
 * @param {boolean} [opts.headers=true]                          Send X-RateLimit-* headers
 * @param {() => number} [opts.now]                              Clock (ms), used for the Reset header
 */
function rateLimit({
  limiter,
  keyGenerator = defaultKeyGenerator,
  cost = 1,
  skip,
  failOpen = true,
  onError,
  onLimited,
  headers = true,
  now = Date.now,
}) {
  if (!limiter || typeof limiter.check !== "function") {
    throw new TypeError(
      "rateLimit: a limiter with a check() method is required",
    );
  }

  return async function rateLimitMiddleware(req, res, next) {
    if (skip && skip(req)) return next();

    // Only the limiter work is inside try/catch. Errors thrown later by
    // next() must NOT be mistaken for limiter failures.
    let result;
    try {
      const key = await keyGenerator(req);
      const c = typeof cost === "function" ? cost(req) : cost;
      result = await limiter.check(key, c);
    } catch (err) {
      if (onError) onError(err);
      if (failOpen) return next();
      return sendJson(res, 503, { error: "Service Unavailable" });
    }

    if (headers) {
      res.setHeader("X-RateLimit-Limit", String(result.limit));
      res.setHeader("X-RateLimit-Remaining", String(result.remaining));
      // Unix time (seconds) at which the bucket is full again
      res.setHeader(
        "X-RateLimit-Reset",
        String(Math.ceil((now() + result.resetMs) / 1000)),
      );
    }

    if (result.allowed) return next();

    // Retry-After is in whole seconds; round up so clients never retry too early.
    const retryAfterSec = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
    res.setHeader("Retry-After", String(retryAfterSec));

    if (onLimited) return onLimited(req, res, next, result);

    return sendJson(res, 429, {
      error: "Too Many Requests",
      retryAfterSeconds: retryAfterSec,
    });
  };
}

module.exports = { rateLimit, defaultKeyGenerator };
