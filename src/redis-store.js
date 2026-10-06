"use strict";

const fs = require("node:fs");
const path = require("node:path");

const LUA = fs.readFileSync(
  path.join(__dirname, "lua", "token-bucket.lua"),
  "utf8",
);
const COMMAND = "rlTokenBucket";

/**
 * Redis-backed store. Same interface as MemoryStore:
 *   consume(key, { capacity, refillPerSec, cost }) -> Promise<{allowed, remaining, retryAfterMs, resetMs}>
 *   close() -> Promise<void>
 *
 * All bucket logic runs inside Redis in one Lua script, so it is atomic across
 * any number of app servers. Requires an ioredis client (v5).
 *
 * Recommended client options, so a Redis outage fails FAST instead of
 * queueing requests until they time out:
 *
 *   new Redis(url, { enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 500 })
 */
class RedisStore {
  /**
   * @param {object} opts
   * @param {import('ioredis').Redis} opts.client
   * @param {string} [opts.keyPrefix='rl:']   Prefix for every Redis key
   * @param {number} [opts.timeoutMs=200]     Max wait per check (0 disables). The limiter sits on
   *                                          the request path, so it must never hang a request.
   * @param {boolean} [opts.closeClient=false] If true, close() also quits the client
   */
  constructor({
    client,
    keyPrefix = "rl:",
    timeoutMs = 200,
    closeClient = false,
  } = {}) {
    if (!client || typeof client.defineCommand !== "function") {
      throw new TypeError("RedisStore requires an ioredis client");
    }
    this.client = client;
    this.keyPrefix = keyPrefix;
    this.timeoutMs = timeoutMs;
    this.closeClient = closeClient;

    // Register the script once per client. ioredis then calls it with EVALSHA
    // and transparently falls back to EVAL if Redis doesn't have it cached.
    if (typeof client[COMMAND] !== "function") {
      client.defineCommand(COMMAND, { numberOfKeys: 1, lua: LUA });
    }
  }

  async consume(key, { capacity, refillPerSec, cost = 1 }) {
    // Same validation as the in-memory TokenBucket, so both stores behave alike.
    if (!(capacity > 0)) throw new RangeError("capacity must be > 0");
    if (!(refillPerSec > 0)) throw new RangeError("refillPerSec must be > 0");
    if (!(cost > 0) || cost > capacity) {
      throw new RangeError("cost must be > 0 and <= capacity");
    }

    const raw = await this._withTimeout(
      this.client[COMMAND](this.keyPrefix + key, capacity, refillPerSec, cost),
    );
    const [allowed, remaining, retryAfterMs, resetMs] = raw.map(Number);
    return { allowed: allowed === 1, remaining, retryAfterMs, resetMs };
  }

  _withTimeout(promise) {
    if (!this.timeoutMs) return promise;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `Redis rate limit check timed out after ${this.timeoutMs}ms`,
            ),
          ),
        this.timeoutMs,
      );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  async close() {
    if (this.closeClient) await this.client.quit();
  }
}

module.exports = { RedisStore };
