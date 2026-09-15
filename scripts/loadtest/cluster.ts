import autocannon from "autocannon";
import { MetricsSampler, startServer, stopServer, writeResults } from "./harness.js";

// Same shape as cpu-bound.ts (same connections, duration, concurrent
// io-bound traffic) but against the clustered server — directly comparable
// to the single-process baseline from phase 3 and the worker-thread run
// from phase 4. Only /metrics from one worker gets sampled (whichever one
// the sampler's connection happens to land on), so its numbers describe
// that one process, not the whole cluster.
async function main() {
  const server = await startServer("src/server.cluster.ts");
  const sampler = new MetricsSampler();
  sampler.start();

  try {
    const [cpuResult, ioResult] = await Promise.all([
      autocannon({
        url: "http://127.0.0.1:3000/cpu-bound?n=40",
        connections: 10,
        duration: 10,
        title: "cpu-bound-clustered",
      }),
      autocannon({
        url: "http://127.0.0.1:3000/io-bound?delayMs=50",
        connections: 2,
        duration: 10,
        title: "io-bound-concurrent",
      }),
    ]);

    const samples = sampler.stop();
    const dir = await writeResults(
      "cluster",
      [
        { label: "cpu-bound-clustered", result: cpuResult },
        { label: "io-bound-concurrent", result: ioResult },
      ],
      samples,
    );
    console.log(`Results written to ${dir}`);
  } finally {
    await stopServer(server);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
