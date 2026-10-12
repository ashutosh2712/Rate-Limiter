"use strict";

const OUTCOMES = ["allowed", "blocked", "error", "skipped"];

// Latency buckets in milliseconds (reported to Prometheus in seconds).
const DEFAULT_BUCKETS_MS = [0.25, 0.5, 1, 2.5, 5, 10, 25, 50, 100, 250];

/**
 * Tiny metrics collector for the limiter. Plug it in as the observer hook:
 *
 *   const metrics = createMetrics();
 *   app.use(rateLimit({ limiter, onDecision: metrics.record }));
 *   app.get('/metrics', (req, res) => res.type('text/plain').send(metrics.toPrometheus()));
 *
 * Deliberately NOT labelled by key/user/IP: one time series per user would
 * explode your metrics backend. Counters are per outcome only.
 */
function createMetrics({ bucketsMs = DEFAULT_BUCKETS_MS } = {}) {
  const bounds = [...bucketsMs].sort((a, b) => a - b);
  let counts;
  let latency;

  function reset() {
    counts = Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
    latency = { count: 0, sumMs: 0, buckets: new Array(bounds.length).fill(0) }; // non-cumulative
  }
  reset();

  /** Observer: pass as `onDecision`. Safe to call unbound. */
  function record(event) {
    if (!OUTCOMES.includes(event.outcome)) return;
    counts[event.outcome]++;

    // Skipped requests never touched the limiter, so they have no latency to report.
    if (event.outcome === "skipped") return;

    const ms = event.durationMs;
    latency.count++;
    latency.sumMs += ms;
    const i = bounds.findIndex((b) => ms <= b);
    if (i !== -1) latency.buckets[i]++; // above the last bound falls in +Inf (count only)
  }

  /** Plain-object view, handy for tests, logs or a JSON endpoint. */
  function snapshot() {
    return {
      ...counts,
      total: OUTCOMES.reduce((s, o) => s + counts[o], 0),
      latency: {
        count: latency.count,
        sumMs: latency.sumMs,
        avgMs: latency.count ? latency.sumMs / latency.count : 0,
      },
    };
  }

  /** Prometheus text exposition format. */
  function toPrometheus({ prefix = "ratelimit" } = {}) {
    const lines = [];
    lines.push(
      `# HELP ${prefix}_requests_total Rate limiter decisions by outcome.`,
    );
    lines.push(`# TYPE ${prefix}_requests_total counter`);
    for (const o of OUTCOMES)
      lines.push(`${prefix}_requests_total{outcome="${o}"} ${counts[o]}`);

    lines.push(
      `# HELP ${prefix}_check_duration_seconds Time spent inside the limiter check.`,
    );
    lines.push(`# TYPE ${prefix}_check_duration_seconds histogram`);
    let cumulative = 0;
    bounds.forEach((b, i) => {
      cumulative += latency.buckets[i];
      lines.push(
        `${prefix}_check_duration_seconds_bucket{le="${b / 1000}"} ${cumulative}`,
      );
    });
    lines.push(
      `${prefix}_check_duration_seconds_bucket{le="+Inf"} ${latency.count}`,
    );
    lines.push(`${prefix}_check_duration_seconds_sum ${latency.sumMs / 1000}`);
    lines.push(`${prefix}_check_duration_seconds_count ${latency.count}`);
    return lines.join("\n") + "\n";
  }

  return { record, snapshot, toPrometheus, reset };
}

module.exports = { createMetrics };
