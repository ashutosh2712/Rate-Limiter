"use strict";

const { TokenBucket } = require("./token-bucket");

/**
 * In-memory store: one TokenBucket per key.
 *
 * Store interface (the seam a Redis store will implement in step 5):
 *   consume(key, { capacity, refillPerSec, cost }) -> Promise<{allowed, remaining, retryAfterMs}>
 *   close() -> Promise<void>
 *
 * The interface is async even though this implementation is synchronous,
 * because a network-backed store has to be.
 */
class MemoryStore {
  /**
   * @param {object} [opts]
   * @param {() => number} [opts.now]           Clock in ms (injectable for tests)
   * @param {number} [opts.cleanupIntervalMs]   Sweep period; 0 disables the timer
   */
  constructor({ now = Date.now, cleanupIntervalMs = 60_000 } = {}) {
    this.now = now;
    this.buckets = new Map();
    this._timer = null;

    if (cleanupIntervalMs > 0) {
      this._timer = setInterval(() => this.cleanup(), cleanupIntervalMs);
      // Don't let this timer keep the process alive (e.g. on shutdown or in tests).
      this._timer.unref();
    }
  }

  async consume(key, { capacity, refillPerSec, cost = 1 }) {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket({ capacity, refillPerSec, now: this.now });
      this.buckets.set(key, bucket);
    }
    return bucket.consume(cost);
  }

  /**
   * Delete buckets that have fully refilled. They're indistinguishable from
   * a new bucket, so nothing is lost. Returns how many were removed.
   */
  cleanup() {
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      if (bucket.isFull()) {
        this.buckets.delete(key); // deleting during Map iteration is safe in JS
        removed++;
      }
    }
    return removed;
  }

  /** Number of keys currently tracked (useful for tests and metrics). */
  get size() {
    return this.buckets.size;
  }

  async close() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}

module.exports = { MemoryStore };
