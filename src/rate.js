"use strict";

const UNITS_MS = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

/**
 * Turn a human-friendly rule into token bucket parameters.
 *
 *   rate({ limit: 100, per: 'minute' })             -> sustained 100/min, burst 100
 *   rate({ limit: 100, per: 'minute', burst: 20 })  -> sustained 100/min, burst of only 20
 *   rate({ limit: 5, per: 15 * 60 * 1000 })         -> 5 per 15 minutes (window in ms)
 *
 * @returns {{capacity: number, refillPerSec: number}}
 */
function rate({ limit, per, burst }) {
  const windowMs = typeof per === "number" ? per : UNITS_MS[per];
  if (!(limit > 0)) throw new RangeError("limit must be > 0");
  if (!(windowMs > 0)) {
    throw new RangeError(
      `per must be a positive number of ms or one of: ${Object.keys(UNITS_MS).join(", ")}`,
    );
  }
  if (burst !== undefined && !(burst > 0))
    throw new RangeError("burst must be > 0");

  return {
    capacity: burst ?? limit,
    refillPerSec: limit / (windowMs / 1000),
  };
}

module.exports = { rate };
