import { parentPort, workerData } from "node:worker_threads";
import { fibonacci } from "../lib/cpu-task.js";

interface WorkerInput {
  n: number;
}

const { n } = workerData as WorkerInput;
const result = fibonacci(n);

parentPort?.postMessage({ result });
