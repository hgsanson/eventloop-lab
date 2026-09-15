# EventLoop Lab — Spec-Driven Development Document

## 1. Purpose

A backend laboratory to observe, measure, and reason about how Node.js executes different workload types — not a product. Every endpoint exists to make one specific event-loop behavior visible and measurable, so that decisions with real production impact (blocking the loop, ignoring backpressure, misusing worker threads) can be seen rather than assumed.

## 2. Goals

- Compare I/O-bound vs CPU-bound execution and show their effect on request latency/throughput for *other* concurrent requests.
- Demonstrate CPU-bound work moved off the main thread via Worker Threads, and its trade-offs (serialization cost, thread startup, no shared memory by default).
- Demonstrate large-file processing via Streams, and what happens with/without backpressure handling.
- Provide a load-testing harness that produces comparable, repeatable numbers across endpoints.
- Collect latency, throughput, memory, and event-loop-lag metrics for every experiment.
- Document each experiment's hypothesis, method, and observed result in a final README.

## 3. Non-Goals

- No authentication, persistence, or multi-service architecture — this is a single process lab.
- No production hardening (rate limiting, retries, graceful shutdown edge cases) beyond what's needed to keep experiments valid.
- No horizontal scaling / `cluster` module comparison in v1 (candidate for a future experiment, not in initial scope).
- No UI — results are JSON/Markdown reports, optionally a simple static chart later.

## 4. Tech Stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node.js (LTS) | Subject of study itself. |
| Package manager | **pnpm** | Content-addressable store (faster installs, less disk), and a strict `node_modules` that surfaces phantom dependencies — a useful property in a lab where "what's actually a dependency" matters. |
| Language | TypeScript (strict) | Types make the "shared CPU function used by both direct route and worker" contract explicit; catches mismatches between main-thread and worker payloads. |
| Web framework | **Fastify** | See §4.1 |
| Logger | Pino (built into Fastify) | Structured, low-overhead — won't itself skew latency measurements the way `console.log` or a heavier logger might under load. |
| Load testing | autocannon | Node-native, scriptable in TS, outputs JSON with latency percentiles + req/sec — no extra binary/runtime to install, fits a Node-focused lab. |
| Worker pool | `node:worker_threads` (manual, no library in v1) | The point is to *feel* the raw mechanics (message passing, thread lifecycle) before reaching for an abstraction like `piscina`. A pool library becomes a v2 experiment ("does pooling help, how much"). |
| Metrics | `node:perf_hooks` (`monitorEventLoopDelay`), `process.memoryUsage()`, `process.cpuUsage()` | Built into Node, zero dependencies, exactly the primitives the lab is meant to teach. |
| Dev tooling | `tsx` (dev run), `tsc` (build), `node:test` (unit tests of pure `lib/` functions) | Minimal toolchain, no bundler needed for a backend-only lab. |

### 4.1 Fastify vs Express

Fastify was chosen over Express for reasons specific to this lab's purpose, not generic preference:

1. **Lower, more predictable framework overhead.** Fastify's radix-tree router and schema-based JSON serialization add less noise on top of the numbers we're trying to measure. With Express, part of any latency/throughput delta could be middleware-chain overhead rather than the Node.js behavior under test.
2. **Native async/await error handling.** Express needs manual `try/catch` + `next(err)` or a wrapper util in every async handler; Fastify handles a rejected promise automatically. Every route here is async, so this removes boilerplate that isn't the point of the lab.
3. **Lifecycle hooks fit the metrics use case exactly.** Fastify's `onRequest`/`onSend` hooks are the natural place to timestamp each request for latency measurement, with no extra middleware layer — this maps directly to the `plugins/metrics.ts` design in §5.
4. **Built-in Pino logger.** One less dependency decision, and log timestamps line up with metrics sampling out of the box.
5. **Plugin encapsulation.** Fastify's plugin system enforces the same boundary the file structure wants: the observability layer is a self-contained plugin, not something bolted onto `app.ts`.

Caveat, stated plainly: the phenomena under study (event loop blocking, backpressure, worker threads) are framework-agnostic — they happen at the Node.js/libuv level. Express would demonstrate the same underlying behavior. Fastify is chosen for measurement cleanliness and lower ceremony, not because Express couldn't do this.

## 5. File Structure

```
eventloop-lab/
├── src/
│   ├── server.ts                 # entry point: builds app, starts listening (single process)
│   ├── server.cluster.ts         # cluster entry point: node:cluster primary forks N workers, each runs app.ts
│   ├── app.ts                    # creates Fastify instance, registers plugins/routes
│   ├── config.ts                 # ports, defaults, tunable constants (kept out of route files)
│   ├── plugins/
│   │   └── metrics.ts            # Fastify plugin: latency hook (onRequest/onSend), event-loop lag sampler, memory sampler, GET /metrics
│   ├── routes/
│   │   ├── io-bound.route.ts
│   │   ├── cpu-bound.route.ts
│   │   ├── cpu-worker.route.ts
│   │   ├── streams.route.ts
│   │   └── backpressure.route.ts
│   ├── workers/
│   │   └── cpu-task.worker.ts    # worker_threads entry point (must be its own file/module)
│   ├── lib/
│   │   ├── cpu-task.ts           # pure CPU-bound function, shared by cpu-bound.route.ts and cpu-task.worker.ts
│   │   ├── io-task.ts            # simulated I/O (non-blocking delay / fake external call)
│   │   └── metrics-collector.ts  # event-loop-lag + memory sampling logic (used by the metrics plugin)
│   └── types/
│       └── index.ts
├── scripts/
│   ├── generate-large-file.ts    # produces the fixture file used by streams/backpressure routes
│   └── loadtest/
│       ├── io-bound.ts
│       ├── cpu-bound.ts
│       ├── cpu-worker.ts
│       └── run-all.ts            # runs every load-test script, writes results/
├── results/                      # load-test + metrics output per run (gitignored, kept via .gitkeep)
├── docs/
│   ├── SDD.md                    # this document
│   └── experiments/              # one .md per experiment: hypothesis, method, result, conclusion
├── package.json
├── tsconfig.json
├── .gitignore
└── README.md                     # final write-up, links to docs/experiments/*
```

**Rationale for the split:**

- `routes/` stays thin — HTTP concerns only (parse query, call `lib/`, reply). This keeps the CPU/I/O logic testable without spinning up Fastify.
- `lib/` holds pure, framework-free functions. Critically, `cpu-task.ts` is imported by **both** `cpu-bound.route.ts` (runs it inline) and `cpu-task.worker.ts` (runs it in a worker) — same function, two execution contexts, so any latency difference is attributable to *where* it runs, not *what* it does.
- `workers/` is separated because `worker_threads` requires a real module path to spawn from; keeping it isolated from `routes/` avoids accidentally pulling Fastify internals into the worker bundle.
- `plugins/` is where cross-cutting instrumentation lives, matching Fastify's own encapsulation model — the metrics layer can be reasoned about (and disabled) independently of business routes.
- `scripts/` is tooling, not runtime app code — it should never be imported by `src/`, only run standalone via `tsx`.
- `results/` and `docs/experiments/` separate raw data from the written interpretation of that data, so the README's conclusions always point at reproducible artifacts.

## 6. Endpoints

| Endpoint | Behavior | What it demonstrates |
|---|---|---|
| `GET /health` | Trivial 200 | Sanity check, load-test warm-up target |
| `GET /io-bound?delayMs=200` | Non-blocking wait (timer-based, simulating an external call) | Event loop stays free; throughput scales with concurrency, not with `delayMs` |
| `GET /cpu-bound?n=40` | Synchronous CPU-heavy function (e.g. naive recursive Fibonacci or prime counting) run on the main thread | Blocks the event loop — concurrent `/io-bound` calls stall too |
| `GET /cpu-bound-worker?n=40` | Same function from `lib/cpu-task.ts`, executed in a `worker_threads` Worker | Main thread stays responsive; cost of message passing/thread spin-up becomes visible |
| `GET /stream/download` | Streams a large generated file via `fs.createReadStream` piped to the response | Constant memory regardless of file size |
| `GET /stream/download-naive` | Reads the same file fully into memory (`fs.readFile`) then sends it | Memory spikes proportional to file size — direct contrast with the streamed version |
| `POST /backpressure/correct` | Writes to a slow downstream respecting `drain` events | Bounded memory under a slow consumer |
| `POST /backpressure/naive` | Writes ignoring `drain`/backpressure signals | Unbounded buffering — memory growth under the same slow consumer |
| `GET /metrics` | Current event-loop lag (mean/p50/p99), `process.memoryUsage()`, uptime | Machine-readable snapshot correlated against load-test runs |

## 7. Metrics & Observability

- **Event-loop lag**: `perf_hooks.monitorEventLoopDelay({ resolution: 10 })`, started once at boot, exposed via `/metrics` and sampled on an interval into `results/<run>/eventloop.csv` during load tests.
- **Memory**: `process.memoryUsage()` (rss, heapUsed, heapTotal, external) sampled on the same interval, same CSV, so memory and lag can be plotted against the same timeline.
- **Latency/throughput**: taken directly from autocannon's JSON output (p50/p90/p99/p99.9, req/sec, bytes/sec) — not re-measured manually, to avoid double-counting overhead.
- **Correlation**: `scripts/loadtest/run-all.ts` starts the sampler, runs autocannon against one endpoint, stops the sampler, and writes both outputs plus a generated `report.md` summary into `results/<endpoint>-<timestamp>/`.

## 8. Experiments (initial set)

Each gets a file in `docs/experiments/` with: Hypothesis → Setup → How to run → Observed result → Conclusion (trade-offs for real production systems).

1. **Baseline I/O-bound under load** — expect near-linear throughput scaling, low/flat event-loop lag.
2. **CPU-bound (direct) under load** — expect throughput collapse and lag spikes; also fire concurrent `/io-bound` requests during the run to show cross-request contamination.
3. **CPU-bound via worker thread**, same load — expect `/io-bound` unaffected this time; CPU throughput bounded by core count, not by the event loop.
4. **Streamed vs naive file download** — expect flat memory (streamed) vs memory proportional to file size (naive), same file, same load pattern.
5. **Backpressure correct vs naive** — slow consumer, fast producer — expect bounded memory (correct) vs continuous growth (naive) until OOM or throttling.
6. **Clustering (`node:cluster`) vs single process for CPU-bound load** — `server.cluster.ts` forks N = CPU-core-count workers sharing one port; hammer `/cpu-bound` and compare aggregate throughput/lag against the phase-1 single-process baseline. Expect near-linear throughput scaling with core count, because each worker is a separate OS process with its own event loop — unlike Worker Threads, which keep one event loop for I/O and only offload the CPU function. This is the key trade-off to surface: clustering scales *whole request handling*, Worker Threads scale *one blocking function* while keeping a single I/O-serving event loop.
7. *(stretch)* **Worker pool size tuning** — 1 worker vs N = CPU core count under sustained concurrent CPU load, within a single process.

## 9. Implementation Roadmap

| Phase | Deliverable |
|---|---|
| 0 | Project bootstrap: `package.json`, `tsconfig.json`, Fastify skeleton, `/health`, Pino logging |
| 1 | `/io-bound` + `/cpu-bound` (direct) — first blocking-vs-non-blocking contrast |
| 2 | `plugins/metrics.ts` + `/metrics` — latency hook, event-loop lag, memory sampling |
| 3 | Load-test harness (`scripts/loadtest/`) — run experiments 1 & 2, write first reports |
| 4 | `/cpu-bound-worker` + `workers/cpu-task.worker.ts` — run experiment 3 |
| 5 | `scripts/generate-large-file.ts` + `/stream/download(-naive)` — run experiment 4 |
| 6 | `/backpressure/correct` + `/backpressure/naive` — run experiment 5 |
| 7 | `server.cluster.ts` (`node:cluster`, N = CPU cores) — run experiment 6, compare against phase-1 baseline |
| 8 | Consolidate `docs/experiments/*.md` into final `README.md` with cross-experiment conclusions |

Each phase is implemented, then run and explained before moving to the next — the point is to observe the behavior, not just ship the endpoint.

## 10. Conventions

- Comments only where the *why* isn't obvious from the code (e.g., a worker message-passing quirk, a deliberate backpressure violation) — never comments restating what a line does.
- Pure logic (`lib/`) has unit tests via `node:test`; routes and workers are exercised through the load-test scripts, not unit-tested in isolation.
- No dependency is added unless it's the subject of an experiment (e.g., a pool library would be added only for the phase-6 stretch experiment, and called out as such).
