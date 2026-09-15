import autocannon from "autocannon";
import { MetricsSampler, startServer, stopServer, writeResults } from "./harness.js";

// Same shape as cpu-bound.ts (same connections, duration, concurrent
// io-bound traffic) so the two reports are directly comparable — the only
// variable that changes is where fibonacci(40) executes.
async function main() {
  const server = await startServer();
  const sampler = new MetricsSampler();
  sampler.start();

  try {
    const [cpuResult, ioResult] = await Promise.all([
      autocannon({
        url: "http://127.0.0.1:3000/cpu-bound-worker?n=40",
        connections: 10,
        duration: 10,
        title: "cpu-bound-worker",
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
      "cpu-bound-worker",
      [
        { label: "cpu-bound-worker", result: cpuResult },
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
