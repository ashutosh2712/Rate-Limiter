-- Atomic token bucket.
--
-- Redis runs a script start to finish without interleaving any other command,
-- so "read tokens -> refill -> spend -> write back" cannot race, no matter how
-- many app servers call this at once.
--
-- KEYS[1]  bucket key (a hash holding `tokens` and `ts`)
-- ARGV[1]  capacity       max tokens (burst size)
-- ARGV[2]  refillPerSec   tokens added per second
-- ARGV[3]  cost           tokens this request spends
--
-- Returns { allowed (1|0), remaining (int), retryAfterMs (int), resetMs (int) }

local key      = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill   = tonumber(ARGV[2])
local cost     = tonumber(ARGV[3])

-- Time comes from Redis, never from the app servers, so clock skew between
-- servers cannot give one of them extra tokens.
local t   = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000) -- milliseconds

local data   = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts     = tonumber(data[2])

if tokens == nil or ts == nil then
  -- First sighting (or the key expired): behaves like a brand-new full bucket.
  tokens = capacity
  ts     = now
end

-- Lazy refill. Capacity is applied on every call, so changing a rule's
-- config takes effect immediately for existing buckets.
local elapsed = math.max(0, now - ts)
tokens = math.min(capacity, tokens + (elapsed / 1000) * refill)

local allowed = 0
local retryAfterMs = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retryAfterMs = math.ceil(((cost - tokens) / refill) * 1000)
end

local resetMs = math.ceil(((capacity - tokens) / refill) * 1000)

redis.call('HSET', key, 'tokens', tokens, 'ts', now)

-- Idle cleanup: expire the key shortly after the bucket would be full again.
-- A full bucket is identical to a missing one, so nothing is lost.
redis.call('PEXPIRE', key, resetMs + 1000)

return { allowed, math.floor(tokens), retryAfterMs, resetMs }