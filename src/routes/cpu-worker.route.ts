import type { FastifyInstance } from "fastify";
import { Worker } from "node:worker_threads";

interface CpuWorkerQuery {
  n?: number;
}

interface WorkerOutput {
  result: number;
}

function runInWorker(n: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../workers/cpu-task.worker.js", import.meta.url), {
      workerData: { n },
    });

    worker.once("message", (data: WorkerOutput) => {
      resolve(data.result);
      void worker.terminate();
    });

    worker.once("error", reject);
  });
}

export async function cpuWorkerRoute(app: FastifyInstance) {
  app.get<{ Querystring: CpuWorkerQuery }>(
    "/cpu-bound-worker",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            n: { type: "integer", minimum: 1, maximum: 50, default: 40 },
          },
        },
      },
    },
    async (request) => {
      const { n = 40 } = request.query;
      const start = performance.now();
      const result = await runInWorker(n);
      return { n, result, elapsedMs: performance.now() - start };
    },
  );
}
