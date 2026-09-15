import type { FastifyInstance, FastifyReply } from "fastify";
import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const FILE_PATH = path.resolve("data", "large-file.bin");

function ensureFixtureExists(reply: FastifyReply): boolean {
  if (existsSync(FILE_PATH)) return true;
  reply.code(500).send({ error: "Fixture file not found. Run: pnpm generate:file" });
  return false;
}

export async function streamsRoute(app: FastifyInstance) {
  // Constant memory: Fastify pipes the readable stream to the response one
  // chunk at a time, only ever holding one chunk in memory regardless of
  // file size.
  app.get("/stream/download", async (_request, reply) => {
    if (!ensureFixtureExists(reply)) return;
    reply.type("application/octet-stream");
    return reply.send(createReadStream(FILE_PATH));
  });

  // Naive contrast: the entire file is loaded into memory before a single
  // byte is sent — memory footprint scales with file size.
  app.get("/stream/download-naive", async (_request, reply) => {
    if (!ensureFixtureExists(reply)) return;
    const buffer = await readFile(FILE_PATH);
    reply.type("application/octet-stream");
    return reply.send(buffer);
  });
}
