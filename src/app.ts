import Fastify from "fastify";
import { config } from "./config.js";

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

  return app;
}
