import Fastify from "fastify";
import { config } from "./config.js";
import { registerMetrics } from "./plugins/metrics.js";
import { ioBoundRoute } from "./routes/io-bound.route.js";
import { cpuBoundRoute } from "./routes/cpu-bound.route.js";
import { cpuWorkerRoute } from "./routes/cpu-worker.route.js";
import { streamsRoute } from "./routes/streams.route.js";
import { backpressureRoute } from "./routes/backpressure.route.js";

export function buildApp() {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      transport:
        process.env.NODE_ENV === "production"
          ? undefined
          : { target: "pino-pretty" },
    },
  });

  registerMetrics(app);

  app.get("/health", async () => {
    return { status: "ok" };
  });

  app.register(ioBoundRoute);
  app.register(cpuBoundRoute);
  app.register(cpuWorkerRoute);
  app.register(streamsRoute);
  app.register(backpressureRoute);

  return app;
}
