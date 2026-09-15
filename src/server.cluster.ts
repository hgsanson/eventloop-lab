import cluster from "node:cluster";
import os from "node:os";
import { buildApp } from "./app.js";
import { config } from "./config.js";

const numWorkers = Number(process.env.CLUSTER_WORKERS ?? os.cpus().length);

if (cluster.isPrimary) {
  console.log(`Primary ${process.pid} forking ${numWorkers} workers`);

  for (let i = 0; i < numWorkers; i++) {
    cluster.fork();
  }

  cluster.on("exit", (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} exited (${signal ?? code}) — restarting`);
    cluster.fork();
  });

  // A worker process is a separate OS process, not a child of this one in
  // the signal-propagation sense — SIGTERM sent only to the primary would
  // leave workers running and still bound to the port.
  process.on("SIGTERM", () => {
    for (const worker of Object.values(cluster.workers ?? {})) {
      worker?.kill();
    }
    process.exit(0);
  });
} else {
  const app = buildApp();
  app.listen({ port: config.port, host: config.host }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
