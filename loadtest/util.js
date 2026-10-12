"use strict";

/**
 * Resolve once an ioredis client is connected and ready.
 *
 * Needed because we create clients with enableOfflineQueue:false (fail fast
 * when Redis is down). ioredis connects asynchronously, so commands sent
 * before the 'ready' event are rejected instead of queued.
 */
function waitForRedis(client, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    if (client.status === "ready") return resolve();

    let lastError;
    const onError = (err) => {
      lastError = err;
    };
    const onReady = () => finish();
    const timer = setTimeout(() => {
      const why = lastError ? `: ${lastError.message}` : "";
      finish(
        new Error(
          `Redis not ready after ${timeoutMs}ms${why}. Is it running? (docker compose up -d)`,
        ),
      );
    }, timeoutMs);

    function finish(err) {
      clearTimeout(timer);
      client.off("ready", onReady);
      client.off("error", onError);
      if (err) reject(err);
      else resolve();
    }

    client.on("ready", onReady);
    client.on("error", onError);
  });
}

module.exports = { waitForRedis };
