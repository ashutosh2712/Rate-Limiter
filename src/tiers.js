"use strict";

const { RateLimiter } = require("./rate-limiter");
const { MemoryStore } = require("./memory-store");

/**
 * Pick a different limiter per request based on a tier (free / pro / ...).
 * Returns a function (req) => RateLimiter, which rateLimit() accepts as `limiter`.
 *
 *   const limiter = byTier({
 *     tiers: {
 *       free: rate({ limit: 60,   per: 'minute' }),
 *       pro:  rate({ limit: 600,  per: 'minute' }),
 *     },
 *     getTier: (req) => req.user?.plan,   // derive from your auth, NEVER a client header
 *     defaultTier: 'free',
 *   });
 *
 * Unknown or missing tiers fall back to defaultTier.
 */
function byTier({
  tiers,
  getTier,
  defaultTier,
  store = new MemoryStore(),
  name = "tier",
}) {
  if (!tiers || Object.keys(tiers).length === 0)
    throw new TypeError("tiers are required");
  if (typeof getTier !== "function")
    throw new TypeError("getTier must be a function");
  if (!Object.hasOwn(tiers, defaultTier)) {
    throw new TypeError(`defaultTier "${defaultTier}" is not one of the tiers`);
  }

  // A Map, not a plain object: the tier name may come from user data, and
  // a lookup like limiters['constructor'] on an object would hit the prototype.
  const limiters = new Map(
    Object.entries(tiers).map(([tier, cfg]) => [
      tier,
      new RateLimiter({ ...cfg, name: `${name}:${tier}`, store }),
    ]),
  );

  const select = (req) =>
    limiters.get(getTier(req)) ?? limiters.get(defaultTier);
  select.limiters = limiters;
  select.close = () => store.close();
  return select;
}

module.exports = { byTier };
