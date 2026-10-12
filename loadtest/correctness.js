"use strict";

/**
 * Multi-process correctness test: the point of the whole project.
 *
 * Starts PROCS server processes (simulated "app servers"), fires REQUESTS
 * requests at them round-robin, ALL for the same key, then asks every server
 * how many requests it actually admitted. With a shared Redis store the total
 * must equal CAPACITY exactly. With the in-memory store each process has its
 * own bucket, so the total is up to PROCS x CAPACITY (that's the bug Redis fixes).
 *
 *   STORE=redis PROCS=3 CAPACITY=100 REQUESTS=2000 CONCURRENCY=100 node loadtest/correctness.js
 */

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const path = require("node:path");

const STORE = process.env.STORE || "memory";
const PROCS = Number(process.env.PROCS || 3);
const CAPACITY = Number(process.env.CAPACITY || 100);
const REQUESTS = Number(process.env.REQUESTS || 1000);
const CONCURRENCY = Number(process.env.CONCURRENCY || 50);
const BASE_PORT = Number(process.env.BASE_PORT || 4100);
const RUN = crypto.randomBytes(4).toString("hex"); // fresh limiter name => no leftover Redis state

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];

async function waitReady(port) {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/__stats`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error(`server on :${port} did not start`);
}

async function main() {
  const ports = Array.from({ length: PROCS }, (_, i) => BASE_PORT + i);

  for (const port of ports) {
    children.push(
      spawn(process.execPath, [path.join(__dirname, "server.js")], {
        env: {
          ...process.env,
          PORT: String(port),
          STORE,
          CAPACITY: String(CAPACITY),
          REFILL: "0.0001", // negligible: no extra token can appear during the run
          LIMITER_NAME: `c-${RUN}`,
        },
        stdio: ["ignore", "ignore", "inherit"],
      }),
    );
  }
  await Promise.all(ports.map(waitReady));

  const seen = {};
  let next = 0;
  const started = Date.now();
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= REQUESTS) return;
      try {
        const res = await fetch(`http://127.0.0.1:${ports[i % PROCS]}/`, {
          headers: { "x-client": "shared" },
        });
        await res.text();
        seen[res.status] = (seen[res.status] || 0) + 1;
      } catch {
        seen.error = (seen.error || 0) + 1;
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const elapsed = (Date.now() - started) / 1000;

  const perServer = await Promise.all(
    ports.map((p) =>
      fetch(`http://127.0.0.1:${p}/__stats`).then((r) => r.json()),
    ),
  );
  const admitted = perServer.reduce((s, x) => s + x.admitted, 0);
  const limited = perServer.reduce((s, x) => s + x.limited, 0);
  const errors = perServer.reduce((s, x) => s + x.errors, 0);

  console.log(
    `\nstore=${STORE} processes=${PROCS} capacity=${CAPACITY} requests=${REQUESTS} concurrency=${CONCURRENCY}`,
  );
  console.log(
    `finished in ${elapsed.toFixed(2)}s (${Math.round(REQUESTS / elapsed)} req/s including the test client)\n`,
  );
  perServer.forEach((s) =>
    console.log(
      `  server pid ${s.pid}: admitted=${s.admitted} limited=${s.limited} errors=${s.errors}`,
    ),
  );
  console.log(
    `\n  client saw : 200=${seen[200] || 0}  429=${seen[429] || 0}  other=${REQUESTS - (seen[200] || 0) - (seen[429] || 0)}`,
  );
  console.log(
    `  servers saw: admitted=${admitted}  limited=${limited}  limiter errors=${errors}`,
  );

  let ok = true;
  if ((seen[200] || 0) !== admitted) {
    console.log("\n✖ client and server counts disagree (dropped requests?)");
    ok = false;
  }
  if (errors > 0) {
    console.log(
      `\n✖ ${errors} limiter errors: those requests failed OPEN, so the count below is not meaningful`,
    );
    ok = false;
  }

  if (admitted === CAPACITY) {
    console.log(`\n✔ admitted exactly ${CAPACITY}: no over-admission`);
  } else if (admitted > CAPACITY) {
    console.log(
      `\n${STORE === "memory" && PROCS > 1 ? "⚠" : "✖"} OVER-ADMITTED: ${admitted} requests passed a limit of ${CAPACITY}` +
        (STORE === "memory" && PROCS > 1
          ? "\n  (expected: every in-memory process keeps its own bucket. This is why Redis exists.)"
          : ""),
    );
    if (!(STORE === "memory" && PROCS > 1)) ok = false;
  } else {
    console.log(
      `\n✖ UNDER-ADMITTED: only ${admitted} of ${CAPACITY} (requests lost, or too few were sent)`,
    );
    ok = false;
  }
  process.exitCode = ok ? 0 : 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => children.forEach((c) => c.kill("SIGTERM")));
