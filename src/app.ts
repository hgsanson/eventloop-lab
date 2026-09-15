import Fastify from "fastify";
import { config } from "./config.js";
import { ioBoundRoute } from "./routes/io-bound.route.js";
import { cpuBoundRoute } from "./routes/cpu-bound.route.js";

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

  app.get("/health", async () => {
    return { status: "ok" };
  });

  app.register(ioBoundRoute);
  app.register(cpuBoundRoute);

  return app;
}
