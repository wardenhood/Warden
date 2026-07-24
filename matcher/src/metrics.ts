/**
 * Prometheus metrics for Warden matcher.
 * Minimal, zero-dependency HTTP server exposing OpenMetrics format.
 * Keeps a rolling 10-minute window of latencies for real p50 calculation.
 */

import { createServer } from "node:http";
import { addSSEClient } from "./sse.js";

const LATENCY_WINDOW_MS = 10 * 60 * 1000; // 10-minute sliding window

interface LatencySample {
  ms: number;
  at: number;
}

interface MetricsState {
  deliveries_total: number;
  deliveries_ok: number;
  deliveries_failed: number;
  active_subscriptions: number;
  latency_samples: LatencySample[];
  uptime_start: number;
}

const state: MetricsState = {
  deliveries_total: 0,
  deliveries_ok: 0,
  deliveries_failed: 0,
  active_subscriptions: 0,
  latency_samples: [],
  uptime_start: Date.now(),
};

export function recordDelivery(ok: boolean, latencyMs: number): void {
  state.deliveries_total++;
  if (ok) state.deliveries_ok++;
  else state.deliveries_failed++;

  const now = Date.now();
  state.latency_samples.push({ ms: latencyMs, at: now });
  // Purge samples older than the window
  const cutoff = now - LATENCY_WINDOW_MS;
  while (state.latency_samples.length > 0 && state.latency_samples[0].at < cutoff) {
    state.latency_samples.shift();
  }
}

export function setActiveSubscriptions(n: number): void {
  state.active_subscriptions = n;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function renderMetrics(): string {
  const uptime = Math.floor((Date.now() - state.uptime_start) / 1000);

  // Mean latency from all samples
  const samples = state.latency_samples.map(s => s.ms);
  const meanLatency = samples.length > 0
    ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length)
    : 0;

  // Real p50 from sorted window
  const sorted = [...samples].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const p99 = percentile(sorted, 99);

  return [
    "# HELP warden_deliveries_total Total matched-event deliveries.",
    "# TYPE warden_deliveries_total counter",
    `warden_deliveries_total ${state.deliveries_total}`,
    "",
    "# HELP warden_deliveries_ok Successful webhook deliveries (2xx).",
    "# TYPE warden_deliveries_ok counter",
    `warden_deliveries_ok ${state.deliveries_ok}`,
    "",
    "# HELP warden_deliveries_failed Failed webhook deliveries.",
    "# TYPE warden_deliveries_failed counter",
    `warden_deliveries_failed ${state.deliveries_failed}`,
    "",
    "# HELP warden_active_subscriptions Currently active subscriptions.",
    "# TYPE warden_active_subscriptions gauge",
    `warden_active_subscriptions ${state.active_subscriptions}`,
    "",
    "# HELP warden_latency_mean_ms Mean webhook dispatch latency (10-min window).",
    "# TYPE warden_latency_mean_ms gauge",
    `warden_latency_mean_ms ${meanLatency}`,
    "",
    "# HELP warden_latency_p50_ms 50th percentile webhook dispatch latency (10-min window).",
    "# TYPE warden_latency_p50_ms gauge",
    `warden_latency_p50_ms ${p50}`,
    "",
    "# HELP warden_latency_p95_ms 95th percentile webhook dispatch latency (10-min window).",
    "# TYPE warden_latency_p95_ms gauge",
    `warden_latency_p95_ms ${p95}`,
    "",
    "# HELP warden_latency_p99_ms 99th percentile webhook dispatch latency (10-min window).",
    "# TYPE warden_latency_p99_ms gauge",
    `warden_latency_p99_ms ${p99}`,
    "",
    "# HELP warden_uptime_seconds Matcher process uptime.",
    "# TYPE warden_uptime_seconds counter",
    `warden_uptime_seconds ${uptime}`,
    "",
  ].join("\n");
}

export function startMetricsServer(port = 9090): void {
  const server = createServer((req, res) => {
    // SSE endpoint — live event push from matcher memory
    if (req.url === "/sse") {
      addSSEClient(req, res);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
    res.end(renderMetrics());
  });
  server.listen(port, () => {
    console.log(`[metrics] :${port} (Prometheus scrape target)`);
  });
}
