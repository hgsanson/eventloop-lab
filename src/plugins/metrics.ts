import type { FastifyInstance } from "fastify";
import { recordRequestLatency, snapshotMetrics } from "../lib/metrics-collector.js";

// Called directly on the root app (not via app.register) so the onResponse
// hook applies to every route, including ones registered later in sibling
// plugins — Fastify hooks only flow from parent to child contexts, and
// app.register() would put this hook in its own child context instead.
export function registerMetrics(app: FastifyInstance): void {
  app.addHook("onResponse", async (_request, reply) => {
    recordRequestLatency(reply.elapsedTime);
  });

  app.get("/metrics", async () => snapshotMetrics());
}
