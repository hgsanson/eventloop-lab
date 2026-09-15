<div align="center">

# EventLoop Lab

**A hands on laboratory for understanding how Node.js actually executes work.**

Fastify · TypeScript · Worker Threads · Streams · Clustering · autocannon

</div>

---

## What this is

This is not a product. It is a small backend built specifically to make the Node.js event loop *visible*: to take ideas like "blocking the event loop", "backpressure" and "worker threads" out of theory and into measured, reproducible numbers.

Every endpoint in this API exists to demonstrate exactly one behavior. Every experiment recorded below follows the same shape: a hypothesis, a way to provoke the behavior on purpose, and the numbers that came out of it.

The full design rationale (why Fastify, why pnpm, why this file layout) lives in [`docs/SDD.md`](docs/SDD.md). This document is the results: what was built, what was measured, and what it means for a real production system.

## Table of contents

- [Architecture](#architecture)
- [Project structure](#project-structure)
- [Getting started](#getting-started)
- [API reference](#api-reference)
- [The experiments](#the-experiments)
  1. [I/O bound work does not block the event loop](#1-io-bound-work-does-not-block-the-event-loop)
  2. [CPU bound work blocks everything, including unrelated requests](#2-cpu-bound-work-blocks-everything-including-unrelated-requests)
  3. [Worker Threads free the event loop, at a cost](#3-worker-threads-free-the-event-loop-at-a-cost)
  4. [Streaming keeps memory flat, buffering does not](#4-streaming-keeps-memory-flat-buffering-does-not)
  5. [Ignoring backpressure trades nothing for memory](#5-ignoring-backpressure-trades-nothing-for-memory)
  6. [Clustering scales throughput, but is not full isolation](#6-clustering-scales-throughput-but-is-not-full-isolation)
- [Head to head comparison](#head-to-head-comparison)
- [What this means for production](#what-this-means-for-production)

## Architecture

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node.js | The subject under study |
| Package manager | pnpm | Content addressable store, strict `node_modules` |
| Language | TypeScript (strict) | Types keep the CPU function shared between the direct route and the worker route honest |
| Web framework | Fastify | Low, predictable overhead; lifecycle hooks map directly onto latency instrumentation; async by default |
| Metrics | `node:perf_hooks` (`monitorEventLoopDelay`, `createHistogram`) | Native, zero dependencies, exactly the primitives this lab is about |
| Load generation | autocannon | Node native, scriptable, produces machine readable percentile data |

See [`docs/SDD.md`](docs/SDD.md) for the full reasoning behind each choice, including the Fastify versus Express comparison.

## Project structure

```
src/
  server.ts               single process entry point
  server.cluster.ts        node:cluster entry point, forks one worker per CPU core
  app.ts                   builds the Fastify instance, wires plugins and routes
  config.ts                env driven configuration
  plugins/
    metrics.ts             onResponse hook + GET /metrics
  routes/
    io-bound.route.ts
    cpu-bound.route.ts
    cpu-worker.route.ts
    streams.route.ts
    backpressure.route.ts
  lib/
    cpu-task.ts             the CPU heavy function, shared by the direct route and the worker
    io-task.ts               simulated non blocking wait
    metrics-collector.ts     event loop lag + memory sampling
    slow-writable.ts          simulated slow downstream, used by the backpressure demo
  workers/
    cpu-task.worker.ts       worker_threads entry point
scripts/
  generate-large-file.ts     builds the fixture used by the streaming demo
  loadtest/
    harness.ts               shared start/stop server + metrics sampler + report writer
    io-bound.ts, cpu-bound.ts, cpu-worker.ts, cluster.ts
    run-all.ts                runs every experiment back to back
results/                     one timestamped folder per load test run (json + csv + report.md)
docs/
  SDD.md                     the spec this project was built from
```

## Getting started

```bash
pnpm install

# generate the 300MB fixture file used by the streaming endpoints
pnpm generate:file

# run the server
pnpm dev                 # single process, watch mode
pnpm start:cluster        # clustered, one worker per CPU core

# run one experiment
pnpm loadtest:io
pnpm loadtest:cpu
pnpm loadtest:cpu-worker
pnpm loadtest:cluster

# run all four back to back
pnpm loadtest:all
```

Each `loadtest:*` script starts its own server, waits for it to become healthy, runs autocannon against it while sampling `/metrics` every 250ms, writes `results/<name>-<timestamp>/report.md`, and shuts the server down.

## API reference

| Endpoint | Behavior |
|---|---|
| `GET /health` | Trivial 200, used as a readiness check |
| `GET /io-bound?delayMs=200` | Non blocking wait (`setTimeout` wrapped in a promise) |
| `GET /cpu-bound?n=40` | Naive recursive Fibonacci, run synchronously on the main thread |
| `GET /cpu-bound-worker?n=40` | Same Fibonacci function, run inside a `worker_threads` Worker |
| `GET /stream/download` | Streams the fixture file from disk straight to the response |
| `GET /stream/download-naive` | Reads the entire fixture file into memory before sending it |
| `POST /backpressure/correct` | Writes 200MB into a slow sink, waiting for `drain` |
| `POST /backpressure/naive` | Writes the same 200MB, ignoring the sink's signal to slow down |
| `GET /metrics` | Current event loop lag, request latency histogram, and memory usage |

## The experiments

All load tests below use the same shape unless noted: 10 concurrent connections against the endpoint under test, 2 concurrent connections against `/io-bound?delayMs=50` running at the same time, for 10 seconds.

### 1. I/O bound work does not block the event loop

**Hypothesis.** If work is non blocking, throughput should scale with concurrency, not degrade with it, and the event loop should stay idle regardless of load.

**Result.**

| Metric | Value |
|---|---|
| Requests/sec | 961.7 |
| Latency p50 / p99 | 51ms / 56ms |
| Event loop lag, peak | 32ms |

50 connections at a 50ms delay predicts a theoretical ceiling of exactly 1000 req/s. The measured 961.7 req/s lands right next to that number. The event loop was never the bottleneck here, concurrency math was.

### 2. CPU bound work blocks everything, including unrelated requests

**Hypothesis.** A synchronous CPU heavy handler should not only be slow itself, it should delay every other request queued behind it, because there is only one thread running JavaScript.

**Result.**

| Metric | `cpu-bound` | `io-bound`, running at the same time |
|---|---|---|
| Requests/sec | 0.9 | **0.0** |
| Latency p99 | 8327ms | n/a, zero requests completed |
| Event loop lag, peak | 1076ms | |

Zero. Not slow, zero. For the full 10 seconds of the test, not a single 50ms `/io-bound` request completed, even though its own timer fired on schedule every time. The callback for that timer simply never got a turn, because the event loop was still inside a synchronous Fibonacci call. The sampler that polls `/metrics` every 250ms only managed to record **1 sample out of the 40 expected**: the monitoring endpoint itself was starved by the same mechanism.

That last point matters in production. A monitoring scrape competes for the same event loop as everything else. A severe enough block does not just degrade user traffic, it can blind the very metrics pipeline meant to alert on it.

### 3. Worker Threads free the event loop, at a cost

**Hypothesis.** Moving the Fibonacci call into a `worker_threads` Worker should let the main thread keep serving I/O normally, since the worker has its own thread and its own event loop.

**Result, same load shape as experiment 2.**

| Metric | Direct (experiment 2) | Worker thread |
|---|---|---|
| `cpu-bound*` requests/sec | 0.9 | **5.0** |
| `io-bound` requests/sec | 0.0 | **38.8** (near the 40 req/s theoretical ceiling) |
| Event loop lag, peak | 1076ms | **18.96ms** |
| `/metrics` samples captured | 1 of 40 | **40 of 40** |

Two things improved at once, not one. The I/O endpoint went from fully starved to essentially unaffected. And CPU throughput itself rose too (0.9 to 5.0 req/s), because up to 10 Fibonacci calls could now run in genuinely separate OS threads instead of being serialized on one.

The cost showed up in a single request test: `/cpu-bound-worker` alone took **1186ms**, against **802ms** for the direct call. That difference is the price of spinning up a new thread per request (V8 isolate setup, copying `workerData`). This project spawns one Worker per request on purpose, to make that cost visible; a pooled worker implementation (reusing threads instead of creating them) is the natural next optimization and is called out as a stretch experiment in the SDD.

### 4. Streaming keeps memory flat, buffering does not

**Hypothesis.** Piping a file to the response one chunk at a time should use roughly constant memory regardless of file size. Reading the whole file into a buffer first should use memory proportional to file size, and should not release it immediately.

**Result, downloading the same 300MB fixture file.**

| | Before | During | After |
|---|---|---|---|
| `/stream/download` (`external` memory) | 5MB | **~20MB** | 12MB |
| `/stream/download-naive` (`external` memory) | 5MB | **~305MB** | **~305MB, still elevated** |

The naive endpoint's memory usage tracks the file size almost exactly (305MB measured against a 300MB file). Worse, that memory did not come back down right after the request finished; it stayed at 305MB external / 456MB RSS until the garbage collector eventually acted. Under concurrent traffic, each simultaneous request to that endpoint stacks another full file's worth of memory on top of the last, which is the classic shape of a production incident that looks like a memory leak but is really just an unbounded read.

This also has a latency angle worth naming even though it was not load tested directly here: the naive endpoint sends nothing to the client until the entire file has been read from disk. A slow disk, a very large file, or a proxy with a strict time to first byte timeout can all turn this into a request that is killed before a single byte goes out, something the streamed version avoids simply by starting to send data within milliseconds.

### 5. Ignoring backpressure trades nothing for memory

**Hypothesis.** Writing to a slow consumer without checking `write()`'s return value should let unsent data pile up in memory. Waiting for `drain` when `write()` returns false should keep memory roughly bounded, at no cost to total completion time, since the slow consumer is the real bottleneck either way.

**Setup.** A `Writable` that only accepts one 1MB chunk every 20ms, being fed 200 chunks (200MB total) by two versions of the same loop.

**Result.**

| | RSS before | RSS during |
|---|---|---|
| `/backpressure/naive` | ~122MB | **~320MB, almost instantly** |
| `/backpressure/correct` | ~107MB | **~118 to 168MB, bounded** |

The naive version's `for` loop runs synchronously and calls `write()` 200 times before yielding once, so all 200MB of buffers get allocated up front, well before the slow sink has processed any of them. The correct version checks the return value of `write()`, and because the default high water mark (16KB) is far smaller than one 1MB chunk, it ends up waiting for `drain` after essentially every single write, keeping only one or two chunks in flight at any time.

Both versions take roughly the same wall clock time to finish (the sink's own speed is the real bound in both cases). The only difference is how much unnecessary memory sits around waiting while that happens. This is the shape of a Node process that grows under sustained load and eventually gets killed by an out of memory limit, without ever technically leaking a reference.

**A bug worth naming.** The first version of this experiment reused a single `Buffer` object across all 200 `write()` calls instead of allocating a fresh one each time. Because every call referenced the same object, the naive and correct paths looked nearly identical, both cheap, since the stream's internal queue was only holding 200 references to one allocation. Real traffic never reuses the exact same buffer object, so the fix was to allocate distinct buffers per chunk, which is what actually exposed the difference above. A backpressure demo built on unrealistic data is not a backpressure demo.

### 6. Clustering scales throughput, but is not full isolation

**Hypothesis.** `node:cluster` forking one worker process per CPU core should let CPU bound requests run genuinely in parallel across processes, similar to Worker Threads, but by scaling the whole request handling pipeline rather than a single function.

**Controlled test first, 2 workers.**

| Scenario | `/io-bound` wall time |
|---|---|
| 1 CPU bound request running (1 worker free) | 57ms |
| 2 CPU bound requests running (both workers saturated) | **1.22s** |

This is the key nuance: cluster only protects I/O while a worker is free to take it. Unlike Worker Threads, there is no thread in this model that is architecturally guaranteed to stay free for I/O. Every cluster worker is a full peer that can be doing CPU work when a new connection arrives.

**Full load test, 16 workers (one per core on this machine), same load shape as experiments 2 and 3.**

| Metric | Direct | Worker thread | Cluster |
|---|---|---|---|
| CPU endpoint requests/sec | 0.9 | 5.0 | **6.1** |
| I/O endpoint requests/sec | 0.0 | 38.8 | 19.6 |
| I/O latency, p50 / worst case | n/a | 51ms / 80ms | **50ms / 6093ms** |
| Event loop lag, peak | 1076ms | 18.96ms | 1715ms |

Cluster produced the best raw CPU throughput of the three, since it avoids the per request thread spawn cost that the Worker Threads implementation pays, and 16 processes genuinely running in parallel outperforms 10 short lived threads. But its I/O tail latency is worse than the worker thread approach: most requests land on a free worker and stay fast (p50 of 50ms, identical to baseline), but the worst observed request took over 6 seconds, because it happened to be routed to a worker that was mid Fibonacci call. Round robin scheduling across a shared pool of full processes does not offer the same structural guarantee that a dedicated I/O thread does.

## Head to head comparison

Same 10 second window, same 10 CPU bound connections, same 2 concurrent I/O bound connections, across all four configurations tested:

| Model | CPU req/s | I/O req/s | I/O worst case | Event loop lag, peak |
|---|---|---|---|---|
| Single process, direct call | 0.9 | 0.0 | starved entirely | 1076ms |
| Single process, Worker Threads | 5.0 | 38.8 | 80ms | 19ms |
| Cluster, 16 processes | 6.1 | 19.6 | 6093ms | 1715ms |
| I/O only, no CPU load (baseline) | n/a | 961.7 | 88ms | 32ms |

## What this means for production

**A single blocking call can take down more than the request that caused it.** Experiment 2 showed a 50ms endpoint receive zero completed requests for ten full seconds because of unrelated synchronous work elsewhere in the same process, including the monitoring endpoint that would normally have raised the alarm.

**Worker Threads and clustering solve different problems, and are often used together.** Worker Threads protect one process's ability to keep serving I/O while offloading a specific CPU heavy function. Clustering multiplies the number of full processes handling requests, which raises aggregate throughput but does not give any single request a structural guarantee against sharing a process with a CPU heavy neighbor. A production system with genuinely CPU heavy work often wants both: several clustered processes, each offloading its heavy computation to its own worker pool.

**Streaming is not an optimization, it is a different memory contract.** The naive full buffer read is not just slower, its memory usage is proportional to input size and does not release promptly, which is exactly the shape of an incident that gets misdiagnosed as a leak.

**Backpressure is about memory, not speed.** Respecting `drain` did not make the backpressure demo finish faster, the slow consumer was the bound either way. What changed was how much unread data sat in memory while waiting, which is the difference between a process with flat memory usage under load and one that grows without bound until something kills it.

**Percentiles tell the truth that averages hide.** Cluster's I/O p50 looked identical to the healthy baseline (50ms), and only the p99 and max exposed the occasional request that got unlucky. Any of these findings would have been invisible looking at a mean alone.

---

For the full specification this project was built from, including every design decision and its rationale, see [`docs/SDD.md`](docs/SDD.md).
