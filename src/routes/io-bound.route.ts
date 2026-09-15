import type { FastifyInstance } from "fastify";
import { simulateIO } from "../lib/io-task.js";

interface IoBoundQuery {
  delayMs?: number;
}

export async function ioBoundRoute(app: FastifyInstance) {
  app.get<{ Querystring: IoBoundQuery }>(
    "/io-bound",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            delayMs: { type: "integer", minimum: 0, maximum: 5000, default: 200 },
          },
        },
      },
    },
    async (request) => {
      const { delayMs = 200 } = request.query;
      const start = performance.now();
      await simulateIO(delayMs);
      return { delayMs, elapsedMs: performance.now() - start };
    },
  );
}
