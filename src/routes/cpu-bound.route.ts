import type { FastifyInstance } from "fastify";
import { fibonacci } from "../lib/cpu-task.js";

interface CpuBoundQuery {
  n?: number;
}

export async function cpuBoundRoute(app: FastifyInstance) {
  app.get<{ Querystring: CpuBoundQuery }>(
    "/cpu-bound",
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
      const result = fibonacci(n);
      return { n, result, elapsedMs: performance.now() - start };
    },
  );
}
