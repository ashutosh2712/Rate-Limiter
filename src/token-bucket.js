"use strict";

/**
 * Token bucket: holds up to `capacity` tokens, refilled continuously at
 * `refillPerSec`. Each request consumes tokens. Refill is lazy: computed
 * from elapsed time when consume() is called, so no timers are needed.
 */
class TokenBucket {
  /**
   * @param {object} opts
   * @param {number} opts.capacity      Max tokens (also the max burst size)
   * @param {number} opts.refillPerSec  Tokens added per second
   * @param {() => number} [opts.now]   Clock in ms (injectable for tests)
   */
  constructor({ capacity, refillPerSec, now = Date.now }) {
    if (!(capacity > 0)) throw new RangeError("capacity must be > 0");
    if (!(refillPerSec > 0)) throw new RangeError("refillPerSec must be > 0");

    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.now = now;

    // A new bucket starts full, so a first-time client can burst.
    this.tokens = capacity;
    this.lastRefill = now();
  }

  /** Add tokens for the time elapsed since the last refill. */
  _refill() {
    const t = this.now();
    const elapsedMs = Math.max(0, t - this.lastRefill); // guard against clock going backwards
    this.tokens = Math.min(
      this.capacity,
      this.tokens + (elapsedMs / 1000) * this.refillPerSec,
    );
    this.lastRefill = t;
  }

  /**
   * True if the bucket has fully refilled. A full bucket behaves exactly like
   * a brand-new one, so stores can safely delete it to free memory.
   */
  isFull() {
    this._refill();
    return this.tokens >= this.capacity;
  }

  /**
   * Try to spend `cost` tokens.
   *
   * @returns {{allowed: boolean, remaining: number, retryAfterMs: number, resetMs: number}}
   *   retryAfterMs: how long until this request would be allowed (0 if allowed)
   *   resetMs:      how long until the bucket is completely full again
   */
  consume(cost = 1) {
    if (!(cost > 0) || cost > this.capacity) {
      throw new RangeError("cost must be > 0 and <= capacity");
    }

    this._refill();

    if (this.tokens >= cost) {
      this.tokens -= cost;
      return {
        allowed: true,
        remaining: Math.floor(this.tokens),
        retryAfterMs: 0,
        resetMs: this._msUntilFull(),
      };
    }

    const missing = cost - this.tokens;
    return {
      allowed: false,
      remaining: Math.floor(this.tokens),
      retryAfterMs: Math.ceil((missing / this.refillPerSec) * 1000),
      resetMs: this._msUntilFull(),
    };
  }
  _msUntilFull() {
    return Math.ceil(
      ((this.capacity - this.tokens) / this.refillPerSec) * 1000,
    );
  }
}

module.exports = { TokenBucket };
