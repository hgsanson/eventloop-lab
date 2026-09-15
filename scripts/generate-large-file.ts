import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const FILE_PATH = path.resolve("data", "large-file.bin");
const SIZE_MB = Number(process.argv[2] ?? 300);
const CHUNK_SIZE = 1024 * 1024;

async function main() {
  await mkdir(path.dirname(FILE_PATH), { recursive: true });

  const chunk = Buffer.alloc(CHUNK_SIZE, "a");
  const stream = createWriteStream(FILE_PATH);

  for (let i = 0; i < SIZE_MB; i++) {
    // Respect backpressure: if write() returns false, the internal buffer is
    // full — wait for "drain" before writing more instead of piling data up
    // in memory. Same rule the naive/correct backpressure demo (phase 6)
    // will violate on purpose.
    if (!stream.write(chunk)) {
      await new Promise((resolve) => stream.once("drain", resolve));
    }
  }
  stream.end();

  await new Promise<void>((resolve, reject) => {
    stream.once("finish", () => resolve());
    stream.once("error", reject);
  });

  console.log(`Generated ${FILE_PATH} (${SIZE_MB} MB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
