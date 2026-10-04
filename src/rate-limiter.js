"use strict";

const { MemoryStore } = require("./memory-store");

/**
 * Public API of the limiter. Holds the rule (capacity + refill rate) and
 * delegates state to a pluggable store.
 *
 * `name` namespaces this limiter's keys inside the store, so several limiters
 * (different routes, tiers...) can safely share ONE store without their
 * buckets colliding. Give every limiter that shares a store a unique name.
 *
 *   const limiter = new RateLimiter({ capacity: 10, refillPerSec: 1 });
 *   const { allowed, remaining, retryAfterMs, limit } = await limiter.check('user:42');
 */
class RateLimiter {
  /**
   * @param {object} opts
   * @param {number} opts.capacity      Max burst size
   * @param {number} opts.refillPerSec  Sustained rate
   * @param {string} [opts.name]        Key namespace (default 'default')
   * @param {object} [opts.store]       Defaults to a new MemoryStore
   */
  constructor({
    capacity,
    refillPerSec,
    name = "default",
    store = new MemoryStore(),
  }) {
    if (!(capacity > 0)) throw new RangeError("capacity must be > 0");
    if (!(refillPerSec > 0)) throw new RangeError("refillPerSec must be > 0");

    if (typeof name !== "string" || name === "") {
      throw new TypeError("name must be a non-empty string");
    }

    this.name = name;
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.store = store;
  }

  /**
   * @param {string} key   Who is being limited (user id, IP, API key...)
   * @param {number} [cost]
   * @returns {Promise<{allowed: boolean, remaining: number, retryAfterMs: number, limit: number}>}
   */
  async check(key, cost = 1) {
    if (typeof key !== "string" || key === "") {
      throw new TypeError("key must be a non-empty string");
    }
    const result = await this.store.consume(`${this.name}:${key}`, {
      capacity: this.capacity,
      refillPerSec: this.refillPerSec,
      cost,
    });
    return { ...result, limit: this.capacity };
  }

  async close() {
    await this.store.close();
  }
}

module.exports = { RateLimiter };
