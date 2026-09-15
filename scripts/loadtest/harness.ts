import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type autocannon from "autocannon";

const BASE_URL = "http://127.0.0.1:3000";

export async function startServer(scriptPath = "src/server.ts"): Promise<ChildProcess> {
  // Spawn the local tsx binary directly, not via `pnpm exec` — pnpm runs it
  // as a grandchild process, so SIGTERM sent to the pnpm process never
  // reaches the actual server and it's left running after the test ends.
  const child = spawn("node_modules/.bin/tsx", [scriptPath], {
    stdio: "ignore",
    env: { ...process.env, LOG_LEVEL: "warn" },
  });

  await waitForHealth();
  return child;
}

export function stopServer(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

async function waitForHealth(retries = 50): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) return;
    } catch {
      // server process is up but not accepting connections yet — keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Server did not become healthy in time");
}

export interface MetricsSample {
  timestamp: number;
  eventLoopLagMeanMs: number;
  eventLoopLagP99Ms: number;
  eventLoopLagMaxMs: number;
  rssMb: number;
  heapUsedMb: number;
}

interface MetricsSnapshot {
  eventLoopDelayMs: { mean: number; p99: number; max: number };
  memoryMb: { rss: number; heapUsed: number };
}

export class MetricsSampler {
  private samples: MetricsSample[] = [];
  private timer: NodeJS.Timeout | undefined;

  start(intervalMs = 250): void {
    this.timer = setInterval(() => {
      void this.sampleOnce();
    }, intervalMs);
  }

  private async sampleOnce(): Promise<void> {
    try {
      const res = await fetch(`${BASE_URL}/metrics`);
      const data = (await res.json()) as MetricsSnapshot;
      this.samples.push({
        timestamp: Date.now(),
        eventLoopLagMeanMs: data.eventLoopDelayMs.mean,
        eventLoopLagP99Ms: data.eventLoopDelayMs.p99,
        eventLoopLagMaxMs: data.eventLoopDelayMs.max,
        rssMb: data.memoryMb.rss,
        heapUsedMb: data.memoryMb.heapUsed,
      });
    } catch {
      // one missed sample doesn't invalidate the run — just skip it
    }
  }

  stop(): MetricsSample[] {
    clearInterval(this.timer);
    return this.samples;
  }
}

export interface NamedResult {
  label: string;
  result: autocannon.Result;
}

export async function writeResults(
  dirName: string,
  results: NamedResult[],
  samples: MetricsSample[],
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.resolve("results", `${dirName}-${timestamp}`);
  await mkdir(dir, { recursive: true });

  for (const { label, result } of results) {
    await writeFile(path.join(dir, `${label}.json`), JSON.stringify(result, null, 2));
  }

  const csvHeader =
    "timestamp,eventLoopLagMeanMs,eventLoopLagP99Ms,eventLoopLagMaxMs,rssMb,heapUsedMb";
  const csvRows = samples.map((s) =>
    [s.timestamp, s.eventLoopLagMeanMs, s.eventLoopLagP99Ms, s.eventLoopLagMaxMs, s.rssMb, s.heapUsedMb].join(","),
  );
  await writeFile(path.join(dir, "eventloop.csv"), [csvHeader, ...csvRows].join("\n"));

  await writeFile(path.join(dir, "report.md"), buildReport(dirName, results, samples));

  return dir;
}

function buildReport(name: string, results: NamedResult[], samples: MetricsSample[]): string {
  const lagMax = samples.length ? Math.max(...samples.map((s) => s.eventLoopLagMaxMs)) : 0;
  const lagMean = samples.length
    ? samples.reduce((sum, s) => sum + s.eventLoopLagMeanMs, 0) / samples.length
    : 0;
  const heapPeak = samples.length ? Math.max(...samples.map((s) => s.heapUsedMb)) : 0;

  const sections = results
    .map(
      ({ label, result }) => `### ${label}

| Metric | Value |
|---|---|
| Requests/sec (avg) | ${result.requests.average.toFixed(1)} |
| Latency avg (ms) | ${result.latency.average.toFixed(2)} |
| Latency p50 (ms) | ${result.latency.p50.toFixed(2)} |
| Latency p99 (ms) | ${result.latency.p99.toFixed(2)} |
| Latency max (ms) | ${result.latency.max.toFixed(2)} |
| Throughput avg (bytes/s) | ${result.throughput.average.toFixed(0)} |
| Errors / timeouts | ${result.errors} / ${result.timeouts} |
| 2xx / non-2xx | ${result["2xx"]} / ${result.non2xx} |
`,
    )
    .join("\n");

  return `# Load test: ${name}

Sampled ${samples.length} event-loop/memory snapshots during the run (every 250ms).

| Sampled metric | Value |
|---|---|
| Event-loop lag, mean of means (ms) | ${lagMean.toFixed(2)} |
| Event-loop lag, peak (ms) | ${lagMax.toFixed(2)} |
| Heap used, peak (MB) | ${heapPeak.toFixed(2)} |

${sections}
`;
}
