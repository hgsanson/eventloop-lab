import type { FastifyInstance } from "fastify";
import { createSlowWritable } from "../lib/slow-writable.js";

const CHUNK_SIZE = 1024 * 1024; // 1MB
const TOTAL_CHUNKS = 200; // 200MB pushed, ~4s of real sink throughput
const SINK_DELAY_MS = 20; // sink accepts one chunk every 20ms

function onceFinish(sink: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve) => sink.once("finish", () => resolve()));
}

export async function backpressureRoute(app: FastifyInstance) {
  // Ignores write()'s return value — keeps producing chunks as fast as the
  // CPU allows, regardless of how fast the sink drains them. All pending
  // chunks pile up in the stream's internal buffer, held in memory.
  app.post("/backpressure/naive", async () => {
    const sink = createSlowWritable(SINK_DELAY_MS);

    // A fresh buffer per chunk — reusing the same buffer object would only
    // queue 200 references to one allocation, hiding the real memory cost.
    for (let i = 0; i < TOTAL_CHUNKS; i++) {
      sink.write(Buffer.alloc(CHUNK_SIZE, "x"));
    }
    sink.end();

    await onceFinish(sink);
    return { mode: "naive", totalChunks: TOTAL_CHUNKS, chunkSizeBytes: CHUNK_SIZE };
  });

  // Checks write()'s return value: false means the sink's internal buffer
  // is full, so we pause and wait for "drain" before writing more — only
  // ever holding roughly one chunk in flight.
  app.post("/backpressure/correct", async () => {
    const sink = createSlowWritable(SINK_DELAY_MS);

    for (let i = 0; i < TOTAL_CHUNKS; i++) {
      const canContinue = sink.write(Buffer.alloc(CHUNK_SIZE, "x"));
      if (!canContinue) {
        await new Promise((resolve) => sink.once("drain", resolve));
      }
    }
    sink.end();

    await onceFinish(sink);
    return { mode: "correct", totalChunks: TOTAL_CHUNKS, chunkSizeBytes: CHUNK_SIZE };
  });
}
