import { createHistogram, monitorEventLoopDelay } from "node:perf_hooks";

// Started once at boot, keeps sampling for the lifetime of the process.
const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
eventLoopDelay.enable();

// Records per-request latency (see plugins/metrics.ts). Values are stored in
// microseconds — Histogram.record() requires a positive integer, and
// millisecond floats would collapse fast requests to 0.
const requestLatency = createHistogram();

function nsToMs(nanoseconds: number): number {
  return nanoseconds / 1e6;
}

function usToMs(microseconds: number): number {
  return microseconds / 1e3;
}

export function recordRequestLatency(elapsedMs: number): void {
  requestLatency.record(Math.max(1, Math.round(elapsedMs * 1e3)));
}

export function snapshotMetrics() {
  const mem = process.memoryUsage();

  return {
    uptimeSeconds: process.uptime(),
    eventLoopDelayMs: {
      mean: nsToMs(eventLoopDelay.mean),
      p50: nsToMs(eventLoopDelay.percentile(50)),
      p99: nsToMs(eventLoopDelay.percentile(99)),
      max: nsToMs(eventLoopDelay.max),
    },
    requestLatencyMs: {
      count: requestLatency.count,
      mean: usToMs(requestLatency.mean),
      p50: usToMs(requestLatency.percentile(50)),
      p99: usToMs(requestLatency.percentile(99)),
    },
    memoryMb: {
      rss: mem.rss / 1024 / 1024,
      heapUsed: mem.heapUsed / 1024 / 1024,
      heapTotal: mem.heapTotal / 1024 / 1024,
      external: mem.external / 1024 / 1024,
    },
  };
}
