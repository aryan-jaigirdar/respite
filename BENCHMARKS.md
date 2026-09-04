# Benchmarks

A small, self-contained load harness lives in `bench/bench.ts`. It measures how many operations per second respite sustains and how long an individual request takes, for a handful of representative workloads. Run it with:

```
npm run bench
```

It has no dependencies beyond the standard library and `tsx` (already a dev dependency), starts its own server, prints a summary table, and exits.

## What is measured

Four workloads, each over a hot keyspace of 10,000 keys with 16-byte values on a single connection:

| Workload | Commands issued |
| --- | --- |
| `SET` | `SET key:i <value>` cycling through the keyspace |
| `GET (hits)` | `GET key:i`, every read a hit (the keyspace is populated first) |
| `INCR` | `INCR n:key:i`, exercising the BigInt integer path |
| `Mixed SET/GET` | Alternating writes and reads over the same keys |

## How it is measured

- **Own event loop.** The server is started as a child process (`src/cli.ts`) on an ephemeral port with no append-only file, so it runs on its own event loop and its own share of the CPU exactly as it would when serving real clients. The benchmark process only drives load.
- **Real socket, real protocol.** Load is driven over `127.0.0.1` through a minimal RESP2 client built on `net.Socket`, the same FIFO reply-ordering approach the test suite's client uses. Replies are framed straight off the wire, so the full path (socket, streaming parser, dispatch, reply serialization) is exercised.
- **Warmup.** Every workload runs a discarded warmup pass before any timed pass, so the numbers reflect steady state rather than cold JIT and allocator behavior.
- **Two passes, two questions.** Throughput and single-request latency pull in opposite directions under pipelining, so each is measured in the regime where it means something:
  - *Throughput* keeps a deep pipeline (depth 512) of commands in flight so the server stays saturated, over 500,000 operations. This is the sustained rate a batching client can push.
  - *Latency* sends one request at a time with no pipelining, over 20,000 round trips, so every sample is a real client-visible round trip. Reported as average and p99. On loopback this is dominated by the socket round trip and OS scheduling, not by the command's own cost, which is why the four workloads land within a hair of each other on latency while differing widely on throughput.

## Results

Measured on this machine:

| Context | Value |
| --- | --- |
| Node | v20.20.2 |
| OS | Ubuntu 24.04.4 LTS, Linux 7.0.0-1011-aws, x86_64 |
| CPU | AMD EPYC 7571, 4 vCPUs |
| Memory | 16 GB |

A representative run:

| Workload | Throughput | Avg latency | p99 latency |
| --- | --- | --- | --- |
| `SET` | 100,825 ops/sec | 0.194 ms | 0.603 ms |
| `GET (hits)` | 179,861 ops/sec | 0.174 ms | 0.518 ms |
| `INCR` | 147,448 ops/sec | 0.185 ms | 0.586 ms |
| `Mixed SET/GET` | 115,363 ops/sec | 0.210 ms | 0.793 ms |

The shape is what you would expect: `GET` is the cheapest command and tops the table, `SET` is the most expensive of the four because each write allocates an entry and touches the LRU list and the memory accounting, and `INCR` and the mixed workload sit in between. The unpipelined latency is nearly flat across workloads, since on localhost the round trip dwarfs the microseconds a single command spends in the engine.

## An honest caveat

These are indicative single-machine numbers, not a claim about production. A few reasons to read them loosely:

- The measurements were taken on a shared 4-vCPU cloud VM, where the benchmark client and the server compete for the same handful of CPUs. Throughput varied by roughly 15 percent run to run, with the occasional slower outlier when the host was busy. Treat the figures as an order of magnitude, not a spec.
- A single connection driven by a single Node process is doing all the client-side framing and timing on one thread, so at these rates the harness itself is part of what is being measured, not only the server.
- Everything is on loopback with no real network, no concurrent clients, and no persistence. A deployment on dedicated cores, over a real network, with an append-only file and many connections, would move these numbers in both directions.
- respite is a single-threaded study of Redis internals, not a tuned production cache. The point of this harness is to make its behavior observable and to catch regressions, not to compete on a leaderboard.

To reproduce, run `npm run bench` and compare against your own hardware.
