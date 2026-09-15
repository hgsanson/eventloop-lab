import { Writable } from "node:stream";

// Simulates a slow downstream (e.g. a rate-limited network peer or a slow
// disk) by only acknowledging each chunk after delayMs — regardless of how
// fast the producer pushes data in.
export function createSlowWritable(delayMs: number): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      setTimeout(callback, delayMs);
    },
  });
}
