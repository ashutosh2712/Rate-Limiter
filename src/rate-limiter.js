"use strict";

const { MemoryStore } = require("./memory-store");

/**
 * Public API of the limiter. Holds the rule (capacity + refill rate) and
 * delegates state to a pluggable store.
 *
 *   const limiter = new RateLimiter({ capacity: 10, refillPerSec: 1 });
 *   const { allowed, remaining, retryAfterMs, limit } = await limiter.check('user:42');
 */
class RateLimiter {
  /**
   * @param {object} opts
   * @param {number} opts.capacity      Max burst size
   * @param {number} opts.refillPerSec  Sustained rate
   * @param {object} [opts.store]       Defaults to a new MemoryStore
   */
  constructor({ capacity, refillPerSec, store = new MemoryStore() }) {
    if (!(capacity > 0)) throw new RangeError("capacity must be > 0");
    if (!(refillPerSec > 0)) throw new RangeError("refillPerSec must be > 0");

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
    const result = await this.store.consume(key, {
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
