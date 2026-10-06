"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { RedisStore, RateLimiter } = require("../src");

// A fake ioredis client: records defineCommand and calls, returns whatever `impl` says.
function fakeClient(impl = async () => [1, 4, 0, 250]) {
  const c = {
    defined: [],
    calls: [],
    quitCalled: false,
    defineCommand(name, def) {
      c.defined.push({ name, def });
      c[name] = async (...args) => {
        c.calls.push(args);
        return impl(...args);
      };
    },
    async quit() {
      c.quitCalled = true;
    },
  };
  return c;
}

const OPTS = { capacity: 5, refillPerSec: 2 };

test("registers the Lua script once per client, with one key", () => {
  const client = fakeClient();
  new RedisStore({ client });
  new RedisStore({ client }); // second store on the same client must not redefine

  assert.equal(client.defined.length, 1);
  assert.equal(client.defined[0].def.numberOfKeys, 1);
  assert.match(client.defined[0].def.lua, /redis\.call\('TIME'\)/);
});

test("sends the prefixed key and exactly (capacity, refillPerSec, cost): no client timestamp", async () => {
  const client = fakeClient();
  const store = new RedisStore({ client, keyPrefix: "app:" });
  await store.consume("api:user42", { ...OPTS, cost: 2 });

  assert.deepEqual(client.calls[0], ["app:api:user42", 5, 2, 2]);
});

test("parses an allowed reply", async () => {
  const store = new RedisStore({
    client: fakeClient(async () => [1, 4, 0, 250]),
  });
  assert.deepEqual(await store.consume("k", OPTS), {
    allowed: true,
    remaining: 4,
    retryAfterMs: 0,
    resetMs: 250,
  });
});

test("parses a denied reply (string numbers are coerced)", async () => {
  const store = new RedisStore({
    client: fakeClient(async () => ["0", "0", "480", "2500"]),
  });
  assert.deepEqual(await store.consume("k", OPTS), {
    allowed: false,
    remaining: 0,
    retryAfterMs: 480,
    resetMs: 2500,
  });
});

test("cost defaults to 1", async () => {
  const client = fakeClient();
  await new RedisStore({ client }).consume("k", OPTS);
  assert.equal(client.calls[0][3], 1);
});

test("rejects invalid arguments before touching the network", async () => {
  const client = fakeClient();
  const store = new RedisStore({ client });
  await assert.rejects(
    () => store.consume("k", { ...OPTS, cost: 6 }),
    RangeError,
  );
  await assert.rejects(
    () => store.consume("k", { ...OPTS, cost: 0 }),
    RangeError,
  );
  await assert.rejects(
    () => store.consume("k", { capacity: 0, refillPerSec: 1 }),
    RangeError,
  );
  await assert.rejects(
    () => store.consume("k", { capacity: 1, refillPerSec: 0 }),
    RangeError,
  );
  assert.equal(client.calls.length, 0);
});

test("times out instead of hanging the request path", async () => {
  const never = () => new Promise(() => {});
  const store = new RedisStore({ client: fakeClient(never), timeoutMs: 20 });
  const started = Date.now();
  await assert.rejects(() => store.consume("k", OPTS), /timed out after 20ms/);
  assert.ok(Date.now() - started < 500);
});

test("timeoutMs: 0 disables the timeout", async () => {
  const slow = () => new Promise((r) => setTimeout(() => r([1, 1, 0, 0]), 40));
  const store = new RedisStore({ client: fakeClient(slow), timeoutMs: 0 });
  assert.equal((await store.consume("k", OPTS)).allowed, true);
});

test("Redis errors propagate (so the middleware failure policy can act)", async () => {
  const boom = async () => {
    throw new Error("ECONNREFUSED");
  };
  const store = new RedisStore({ client: fakeClient(boom) });
  await assert.rejects(() => store.consume("k", OPTS), /ECONNREFUSED/);
});

test("close() leaves a shared client alone unless closeClient is set", async () => {
  const shared = fakeClient();
  await new RedisStore({ client: shared }).close();
  assert.equal(shared.quitCalled, false);

  const owned = fakeClient();
  await new RedisStore({ client: owned, closeClient: true }).close();
  assert.equal(owned.quitCalled, true);
});

test("requires an ioredis-like client", () => {
  assert.throws(() => new RedisStore(), TypeError);
  assert.throws(() => new RedisStore({ client: {} }), TypeError);
});

test("works under RateLimiter, namespacing keys with the limiter name", async () => {
  const client = fakeClient();
  const limiter = new RateLimiter({
    name: "login",
    capacity: 5,
    refillPerSec: 1,
    store: new RedisStore({ client, keyPrefix: "rl:" }),
  });
  const res = await limiter.check("1.2.3.4");

  assert.equal(client.calls[0][0], "rl:login:1.2.3.4");
  assert.equal(res.limit, 5);
  assert.equal(res.allowed, true);
});
