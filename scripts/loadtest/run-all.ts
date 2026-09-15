import { spawnSync } from "node:child_process";

const scripts = ["io-bound.ts", "cpu-bound.ts", "cpu-worker.ts"];

for (const script of scripts) {
  console.log(`\n=== Running ${script} ===`);
  const { status } = spawnSync("pnpm", ["exec", "tsx", `scripts/loadtest/${script}`], {
    stdio: "inherit",
  });
  if (status !== 0) {
    console.error(`${script} failed with exit code ${status}`);
    process.exit(status ?? 1);
  }
}
