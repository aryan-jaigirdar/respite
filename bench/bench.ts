/**
 * Benchmark harness for respite.
 *
 * The server is started as a child process on an ephemeral port with no
 * append-only file, so it runs on its own event loop exactly as it would in
 * production and this process only drives load. A single connection speaks
 * RESP2 over a net.Socket, reusing the FIFO reply-ordering contract the test
 * client relies on and adapting it to keep a window of commands in flight
 * rather than one at a time.
 *
 * Each workload is measured in two passes, both after a discarded warmup:
 *
 *   - Throughput: a deep pipeline keeps the server saturated, and ops/sec is
 *     total operations over wall time. This is the sustained rate the server
 *     can push when a client batches requests.
 *   - Latency: one request at a time (no pipelining), so each sample is a real
 *     client-visible round trip. Reported as average and p99. On loopback this
 *     is dominated by the socket round trip and OS scheduling, not by the
 *     command's own cost.
 *
 * Numbers are printed to stdout. See BENCHMARKS.md for context and a recorded
 * run. Run with `npm run bench`.
 */

import net from 'node:net';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { encodeCommand } from '../src/resp/writer.js';

const HOST = '127.0.0.1';

/** The server child: stdin ignored, stdout and stderr piped for the banner. */
type ServerProcess = ChildProcessByStdio<null, Readable, Readable>;

/** Distinct keys each workload cycles through; a small hot keyspace. */
const KEYSPACE = 10_000;
/** Fixed value payload; documented in BENCHMARKS.md. */
const VALUE = 'x'.repeat(16);

/** Commands kept in flight while measuring throughput. */
const THROUGHPUT_PIPELINE = 512;
/** Operations discarded before the throughput pass so the JIT settles. */
const THROUGHPUT_WARMUP = 50_000;
/** Operations timed for throughput. */
const THROUGHPUT_OPS = 500_000;

/** No pipelining: one request, one reply, so each sample is a round trip. */
const LATENCY_PIPELINE = 1;
/** Operations discarded before the latency pass. */
const LATENCY_WARMUP = 3_000;
/** Round trips timed for latency percentiles. */
const LATENCY_OPS = 20_000;

interface WorkloadResult {
  name: string;
  opsPerSec: number;
  avgMs: number;
  p99Ms: number;
}

/**
 * Returns the offset just past one complete RESP reply at `pos`, or -1 when
 * the buffer does not yet hold a full reply. Only reply framing is needed to
 * keep the pipeline accounting correct, so no value is materialized.
 */
function frameEnd(buffer: Buffer, pos: number): number {
  if (pos >= buffer.length) return -1;
  const type = buffer[pos]!;
  const newline = buffer.indexOf(0x0a, pos); // '\n'; lines terminate with \r\n
  if (newline === -1) return -1;

  // '+' simple string, '-' error, ':' integer are single-line replies.
  if (type === 0x2b || type === 0x2d || type === 0x3a) return newline + 1;

  if (type === 0x24) {
    // '$' bulk string: header line, then that many bytes plus CRLF.
    const length = Number(buffer.toString('latin1', pos + 1, newline - 1));
    if (length === -1) return newline + 1;
    const end = newline + 1 + length + 2;
    return end <= buffer.length ? end : -1;
  }

  if (type === 0x2a) {
    // '*' array: header line, then that many nested replies.
    const count = Number(buffer.toString('latin1', pos + 1, newline - 1));
    let cursor = newline + 1;
    if (count === -1) return cursor;
    for (let i = 0; i < count; i++) {
      const next = frameEnd(buffer, cursor);
      if (next === -1) return -1;
      cursor = next;
    }
    return cursor;
  }

  throw new Error(`unexpected reply byte 0x${type.toString(16)}`);
}

/**
 * Drives `totalOps` commands over the socket, drawing from `pool` cyclically
 * and holding at most `pipeline` in flight. Resolves with the elapsed wall
 * time and one latency sample per operation, in milliseconds.
 */
function drive(
  socket: net.Socket,
  pool: readonly Buffer[],
  totalOps: number,
  pipeline: number,
): Promise<{ elapsedMs: number; latencies: Float64Array }> {
  return new Promise((resolve, reject) => {
    const latencies = new Float64Array(totalOps);
    const sendTimes = new Float64Array(totalOps);
    let sent = 0;
    let received = 0;
    let pending: Buffer = Buffer.alloc(0);

    const pump = (): void => {
      const chunks: Buffer[] = [];
      const now = performance.now();
      while (sent < totalOps && sent - received < pipeline) {
        chunks.push(pool[sent % pool.length]!);
        sendTimes[sent] = now;
        sent += 1;
      }
      if (chunks.length === 1) socket.write(chunks[0]!);
      else if (chunks.length > 1) socket.write(Buffer.concat(chunks));
    };

    const onData = (chunk: Buffer): void => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let pos = 0;
      for (;;) {
        const next = frameEnd(pending, pos);
        if (next === -1) break;
        latencies[received] = performance.now() - sendTimes[received]!;
        received += 1;
        pos = next;
        if (received === totalOps) {
          socket.off('data', onData);
          socket.off('error', onError);
          resolve({ elapsedMs: performance.now() - start, latencies });
          return;
        }
      }
      if (pos > 0) pending = pending.subarray(pos);
      pump();
    };

    const onError = (error: Error): void => {
      socket.off('data', onData);
      reject(error);
    };

    socket.on('data', onData);
    socket.on('error', onError);
    const start = performance.now();
    pump();
  });
}

/** Sorted-array percentile with linear interpolation between neighbors. */
function percentile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0;
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low]!;
  const weight = rank - low;
  return sorted[low]! * (1 - weight) + sorted[high]! * weight;
}

/** Builds one reusable command per key in the hot keyspace. */
function buildPool(make: (key: string) => Buffer): Buffer[] {
  const pool: Buffer[] = new Array(KEYSPACE);
  for (let i = 0; i < KEYSPACE; i++) {
    pool[i] = make(`key:${i}`);
  }
  return pool;
}

function average(values: Float64Array): number {
  let sum = 0;
  for (const value of values) sum += value;
  return values.length === 0 ? 0 : sum / values.length;
}

async function runWorkload(
  socket: net.Socket,
  name: string,
  pool: readonly Buffer[],
): Promise<WorkloadResult> {
  await drive(socket, pool, THROUGHPUT_WARMUP, THROUGHPUT_PIPELINE);
  const throughput = await drive(socket, pool, THROUGHPUT_OPS, THROUGHPUT_PIPELINE);

  await drive(socket, pool, LATENCY_WARMUP, LATENCY_PIPELINE);
  const latency = await drive(socket, pool, LATENCY_OPS, LATENCY_PIPELINE);

  const sorted = Float64Array.from(latency.latencies).sort();
  return {
    name,
    opsPerSec: (THROUGHPUT_OPS / throughput.elapsedMs) * 1000,
    avgMs: average(latency.latencies),
    p99Ms: percentile(sorted, 99),
  };
}

/** Populates the keyspace so GET and mixed reads are guaranteed hits. */
async function populate(socket: net.Socket): Promise<void> {
  const pool = buildPool((key) => encodeCommand(['SET', key, VALUE]));
  await drive(socket, pool, KEYSPACE, THROUGHPUT_PIPELINE);
}

/** Spawns the server on an ephemeral port and resolves with the bound port. */
function startServer(repoRoot: string): Promise<{ child: ServerProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--port', '0'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let banner = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error('server did not report a listening port in time'));
    }, 15_000);

    child.stdout.on('data', (chunk: Buffer) => {
      banner += chunk.toString('utf8');
      const match = banner.match(/listening on [\d.]+:(\d+)/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ child, port: Number(match[1]) });
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(`server: ${chunk.toString('utf8')}`);
    });

    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`server exited early with code ${String(code)}`));
    });
  });
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host: HOST });
    socket.once('connect', () => {
      socket.setNoDelay(true);
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

function printSummary(results: readonly WorkloadResult[]): void {
  const rows = results.map((r) => ({
    workload: r.name,
    throughput: `${Math.round(r.opsPerSec).toLocaleString('en-US')} ops/sec`,
    avg: `${r.avgMs.toFixed(3)} ms`,
    p99: `${r.p99Ms.toFixed(3)} ms`,
  }));

  const headers = {
    workload: 'Workload',
    throughput: 'Throughput',
    avg: 'Avg latency',
    p99: 'p99 latency',
  };
  const columns = ['workload', 'throughput', 'avg', 'p99'] as const;
  type Column = (typeof columns)[number];
  const width = (col: Column): number =>
    Math.max(headers[col].length, ...rows.map((row) => row[col].length));
  const widths = Object.fromEntries(columns.map((col) => [col, width(col)])) as Record<
    Column,
    number
  >;

  const line = (cells: Record<Column, string>): string =>
    columns.map((col) => cells[col].padEnd(widths[col])).join('  ');

  console.log('');
  console.log(line(headers));
  console.log(columns.map((col) => '-'.repeat(widths[col])).join('  '));
  for (const row of rows) console.log(line(row));
  console.log('');
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  console.log('respite benchmark');
  console.log(
    `node ${process.version}, ${os.type()} ${os.release()} ${os.arch()}, ` +
      `${os.cpus().length} x ${os.cpus()[0]?.model ?? 'unknown cpu'}`,
  );
  console.log(
    `throughput: pipeline depth ${THROUGHPUT_PIPELINE}, ${THROUGHPUT_OPS.toLocaleString('en-US')} ops; ` +
      `latency: no pipelining, ${LATENCY_OPS.toLocaleString('en-US')} round trips`,
  );
  console.log(
    `${VALUE.length}-byte values, ${KEYSPACE.toLocaleString('en-US')} keys, single connection`,
  );

  const { child, port } = await startServer(repoRoot);
  let socket: net.Socket | undefined;
  try {
    socket = await connect(port);
    await populate(socket);

    const results: WorkloadResult[] = [];
    results.push(await runWorkload(socket, 'SET', buildPool((key) => encodeCommand(['SET', key, VALUE]))));
    results.push(await runWorkload(socket, 'GET (hits)', buildPool((key) => encodeCommand(['GET', key]))));
    results.push(await runWorkload(socket, 'INCR', buildPool((key) => encodeCommand(['INCR', `n:${key}`]))));

    // Mixed workload: even ops write, odd ops read, over the same keyspace.
    const mixed = buildPool((key) => encodeCommand(['SET', key, VALUE]));
    const reads = buildPool((key) => encodeCommand(['GET', key]));
    for (let i = 0; i < KEYSPACE; i++) if (i % 2 === 1) mixed[i] = reads[i]!;
    results.push(await runWorkload(socket, 'Mixed SET/GET', mixed));

    printSummary(results);
  } finally {
    if (socket !== undefined) {
      socket.destroy();
    }
    child.kill('SIGTERM');
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
