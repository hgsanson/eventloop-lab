import autocannon from "autocannon";
import { MetricsSampler, startServer, stopServer, writeResults } from "./harness.js";

// Runs the CPU-bound endpoint under load *while* also hammering the
// I/O-bound endpoint concurrently. The io-bound result here is the point of
// the experiment: it shows what happens to unrelated requests while the
// event loop is busy with synchronous work.
async function main() {
  const server = await startServer();
  const sampler = new MetricsSampler();
  sampler.start();

  try {
    const [cpuResult, ioResult] = await Promise.all([
      autocannon({
        url: "http://127.0.0.1:3000/cpu-bound?n=40",
        connections: 10,
        duration: 10,
        title: "cpu-bound",
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
      "cpu-bound",
      [
        { label: "cpu-bound", result: cpuResult },
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
