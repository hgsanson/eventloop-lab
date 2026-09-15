import autocannon from "autocannon";
import { MetricsSampler, startServer, stopServer, writeResults } from "./harness.js";

async function main() {
  const server = await startServer();
  const sampler = new MetricsSampler();
  sampler.start();

  try {
    const result = await autocannon({
      url: "http://127.0.0.1:3000/io-bound?delayMs=50",
      connections: 50,
      duration: 10,
      title: "io-bound",
    });

    const samples = sampler.stop();
    const dir = await writeResults("io-bound", [{ label: "io-bound", result }], samples);
    console.log(`Results written to ${dir}`);
  } finally {
    await stopServer(server);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
