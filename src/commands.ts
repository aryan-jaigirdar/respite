/**
 * Command table and dispatch.
 *
 * Handlers are pure with respect to I/O: they take decoded arguments, mutate
 * the store, and return an encoded reply plus, for successful mutations, the
 * command sequence to append to the AOF. Networking lives in server.ts and
 * persistence wiring in engine.ts, so every command is testable without a
 * socket.
 *
 * AOF propagation is normalized rather than verbatim where time or state is
 * involved:
 *
 * - SET with EX/PX propagates as SET plus an absolute PEXPIREAT.
 * - EXPIRE/PEXPIRE/EXPIREAT propagate as PEXPIREAT.
 * - An expiry in the past propagates as DEL, which is also what it does.
 * - Deterministic mutations (INCR, APPEND, DEL, ...) propagate verbatim.
 */

import os from 'node:os';
import * as resp from './resp/writer.js';
import { globMatch } from './glob.js';
import { VERSION } from './version.js';
import type { Store } from './store.js';
import type { ServerStats } from './stats.js';
import type { AppendOnlyFile } from './aof.js';

export interface CommandContext {
  store: Store;
  stats: ServerStats;
  clock: () => number;
  /** Wall-clock ms timestamp the engine was created at, for INFO uptime. */
  startedAt: number;
  /** Advertised TCP port, for INFO. */
  port: number;
  maxmemory: number;
  /** Null when persistence is disabled or during AOF replay. */
  aof: AppendOnlyFile | null;
  connectedClients: () => number;
}

export interface CommandResult {
  reply: Buffer;
  /** Set by QUIT: flush the reply, then close the connection. */
  close?: boolean;
}

export interface ExecuteOptions {
  /** True while replaying the AOF: skip stats and re-propagation. */
  fromAof?: boolean;
}

type Propagation = (string | Buffer)[];

interface HandlerOutput {
  reply: Buffer;
  close?: boolean;
  /** Commands to append to the AOF; only present after successful mutations. */
  propagate?: Propagation[];
}

type Handler = (ctx: CommandContext, args: Buffer[]) => HandlerOutput;

interface CommandSpec {
  /** Minimum argument count, excluding the command name. */
  minArgs: number;
  /** Maximum argument count, excluding the command name; -1 means unlimited. */
  maxArgs: number;
  handler: Handler;
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
/** Redis' proto-max-bulk-len: the largest value a string key may hold. */
const MAX_VALUE_BYTES = 512 * 1024 * 1024;
const SCAN_DEFAULT_COUNT = 10;

export function execute(
  ctx: CommandContext,
  args: Buffer[],
  options: ExecuteOptions = {},
): CommandResult {
  const nameArg = args[0];
  if (nameArg === undefined) {
    return { reply: resp.errorReply('ERR empty command') };
  }
  if (!options.fromAof) ctx.stats.commandsProcessed += 1;

  const name = nameArg.toString('latin1').toUpperCase();
  const spec = COMMANDS.get(name);
  if (spec === undefined) {
    return { reply: resp.errorReply(`ERR unknown command '${name}'`) };
  }

  const rest = args.slice(1);
  if (rest.length < spec.minArgs || (spec.maxArgs !== -1 && rest.length > spec.maxArgs)) {
    return {
      reply: resp.errorReply(`ERR wrong number of arguments for '${name.toLowerCase()}' command`),
    };
  }

  const output = spec.handler(ctx, rest);
  if (output.propagate !== undefined && ctx.aof !== null && !options.fromAof) {
    for (const command of output.propagate) ctx.aof.append(command);
  }

  const result: CommandResult = { reply: output.reply };
  if (output.close === true) result.close = true;
  return result;
}

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

/** Byte-faithful Buffer to string conversion (latin1 maps bytes 1:1). */
function toStr(buffer: Buffer): string {
  return buffer.toString('latin1');
}

function ok(): HandlerOutput {
  return { reply: resp.simpleString('OK') };
}

function err(message: string): HandlerOutput {
  return { reply: resp.errorReply(message) };
}

/** Strict signed 64-bit integer parse; null on bad syntax or overflow. */
function parseInt64(text: string): bigint | null {
  if (!/^-?\d+$/.test(text) || text.length > 20) return null;
  const value = BigInt(text);
  if (value < INT64_MIN || value > INT64_MAX) return null;
  return value;
}

/** Integer argument that must also be a safe JS number (cursors, counts). */
function parseSafeInt(text: string): number | null {
  if (!/^-?\d+$/.test(text) || text.length > 16) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Strict float parse for INCRBYFLOAT. Accepts an optional sign, decimal
 * digits, and an exponent, matching the grammar Redis' strtold path allows;
 * rejects trailing garbage, whitespace, and non-finite values (inf/nan).
 * Returns null on anything invalid.
 */
function parseFloat64(text: string): number | null {
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/**
 * Renders a finite double the way redis-server prints INCRBYFLOAT results:
 * the shortest decimal that round-trips, with trailing zeros removed and no
 * scientific notation. Number.prototype.toString already gives the shortest
 * form; this only rewrites the exponential spellings (1e-7, 3e+21) it produces
 * for very large or very small magnitudes back into plain decimals.
 */
function formatFloat(value: number): string {
  if (value === 0) return '0'; // also folds -0 to 0
  const text = value.toString();
  if (!/[eE]/.test(text)) return text;

  const negative = value < 0;
  const parts = Math.abs(value).toExponential().split('e');
  const mantissa = parts[0]!;
  const exponent = Number(parts[1]!);
  const digits = mantissa.replace('.', '');
  // Where the decimal point falls relative to the start of `digits`.
  const pointPos = 1 + exponent;

  let out: string;
  if (pointPos <= 0) {
    out = `0.${'0'.repeat(-pointPos)}${digits}`;
  } else if (pointPos >= digits.length) {
    out = digits + '0'.repeat(pointPos - digits.length);
  } else {
    out = `${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`;
  }
  return negative ? `-${out}` : out;
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const units = ['K', 'M', 'G', 'T'];
  let value = bytes;
  let unit = '';
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value.toFixed(2)}${unit}`;
}

/* ------------------------------------------------------------------ */
/* string commands                                                    */
/* ------------------------------------------------------------------ */

function pingCommand(_ctx: CommandContext, args: Buffer[]): HandlerOutput {
  const message = args[0];
  if (message === undefined) return { reply: resp.simpleString('PONG') };
  return { reply: resp.bulk(message) };
}

function echoCommand(_ctx: CommandContext, args: Buffer[]): HandlerOutput {
  return { reply: resp.bulk(args[0]!) };
}

function setCommand(ctx: CommandContext, args: Buffer[]): HandlerOutput {
  const key = toStr(args[0]!);
  const value = args[1]!;
  if (value.length > MAX_VALUE_BYTES) {
    return err('ERR string exceeds maximum allowed size (proto-max-bulk-len)');
  }

  let expireMs: number | null = null;
  let nx = false;
  let xx = false;

  for (let i = 2; i < args.length; i++) {
    const option = toStr(args[i]!).toUpperCase();
    if (option === 'NX') {
      nx = true;
    } else if (option === 'XX') {
      xx = true;
    } else if (option === 'EX' || option === 'PX') {
      if (expireMs !== null) return err('ERR syntax error');
      const raw = args[i + 1];
      if (raw === undefined) return err('ERR syntax error');
      i += 1;
      const amount = parseInt64(toStr(raw));
      if (amount === null) return err('ERR value is not an integer or out of range');
      if (amount <= 0n) return err("ERR invalid expire time in 'set' command");
      const ms = option === 'EX' ? amount * 1000n : amount;
      if (ms > BigInt(Number.MAX_SAFE_INTEGER)) {
        return err("ERR invalid expire time in 'set' command");
      }
      expireMs = Number(ms);
    } else {
      return err('ERR syntax error');
    }
  }

  if (nx && xx) return err('ERR syntax error');
  if (nx || xx) {
    const exists = ctx.store.has(key);
    if ((nx && exists) || (xx && !exists)) return { reply: resp.nullBulk };
  }

  const expireAt = expireMs === null ? null : ctx.clock() + expireMs;
  ctx.store.set(key, value, { expireAt });

  const propagate: Propagation[] = [['SET', key, value]];
  if (expireAt !== null) propagate.push(['PEXPIREAT', key, String(expireAt)]);
  return { ...ok(), propagate };
}

function getCommand(ctx: CommandContext, args: Buffer[]): HandlerOutput {
  const value = ctx.store.get(toStr(args[0]!));
  if (value === null) {
    ctx.stats.keyspaceMisses += 1;
    return { reply: resp.nullBulk };
  }
  ctx.stats.keyspaceHits += 1;
  return { reply: resp.bulk(value) };
}

function delCommand(ctx: CommandContext, args: Buffer[]): HandlerOutput {
  const removedKeys: string[] = [];
  for (const arg of args) {
    const key = toStr(arg);
    if (ctx.store.delete(key)) removedKeys.push(key);
  }
  const output: HandlerOutput = { reply: resp.integer(removedKeys.length) };
  if (removedKeys.length > 0) output.propagate = [['DEL', ...removedKeys]];
  return output;
}

function existsCommand(ctx: CommandContext, args: Buffer[]): HandlerOutput {
  let found = 0;
  for (const arg of args) {
    if (ctx.store.has(toStr(arg))) {
      found += 1;
      ctx.stats.keyspaceHits += 1;
    } else {
      ctx.stats.keyspaceMisses += 1;
    }
  }
  return { reply: resp.integer(found) };
}

function incrDecr(ctx: CommandContext, key: string, delta: bigint, verbatim: Propagation): HandlerOutput {
  const current = ctx.store.get(key);
  let base = 0n;
  if (current !== null) {
    const parsed = parseInt64(toStr(current));
    if (parsed === null) return err('ERR value is not an integer or out of range');
    base = parsed;
  }
  const next = base + delta;
  if (next < INT64_MIN || next > INT64_MAX) {
    return err('ERR increment or decrement would overflow');
  }
  // INCR and friends preserve any existing TTL, like Redis.
  ctx.store.set(key, Buffer.from(next.toString(), 'latin1'), { keepTtl: true });
  return { reply: resp.integer(next), propagate: [verbatim] };
}

function incrCommand(ctx: CommandContext, args: Buffer[]): HandlerOutput {
  const key = toStr(args[0]!);
  return incrDecr(ctx, key, 1n, ['INCR', key]);
}

function decrCommand(ctx: CommandContext, args: Buffer[]): HandlerOutput {
  const key = toStr(args[0]!);
  return incrDecr(ctx, key, -1n, ['DECR', key]);
}

function incrByCommand(ctx: CommandContext, args: Buffer[]): HandlerOutput {
  const key = toStr(args[0]!);
  const delta = parseInt64(toStr(args[1]!));
  if (delta === null) return err('ERR value is not an integer or out of range');
  return incrDecr(ctx, key, delta, ['INCRBY', key, delta.toString()]);
}

function decrByCommand(ctx: CommandContext, args: Buffer[]): HandlerOutput {
  const key = toStr(args[0]!);
  const delta = parseInt64(toStr(args[1]!));
  if (delta === null) return err('ERR value is not an integer or out of range');
  return incrDecr(ctx, key, -delta, ['DECRBY', key, delta.toString()]);
}

function appendCommand(ctx: CommandContext, args: Buffer[]): HandlerOutput {
  const key = toStr(args[0]!);
  const suffix = args[1]!;
  const existing = ctx.store.get(key);
  const next = existing === null ? suffix : Buffer.concat([existing, suffix]);
  if (next.length > MAX_VALUE_BYTES) {
    return err('ERR string exceeds maximum allowed size (proto-max-bulk-len)');
  }
  ctx.store.set(key, next, { keepTtl: true });
  return { reply: resp.integer(next.length), propagate: [['APPEND', key, suffix]] };
}

function strlenCommand(ctx: CommandContext, args: Buffer[]): HandlerOutput {
  const value = ctx.store.get(toStr(args[0]!));
  if (value === null) {
    ctx.stats.keyspaceMisses += 1;
    return { reply: resp.integer(0) };
  }
  ctx.stats.keyspaceHits += 1;
  return { reply: resp.integer(value.length) };
}

function mgetCommand(ctx: CommandContext, args: Buffer[]): HandlerOutput {
  const items: Buffer[] = [];
  for (const arg of args) {
    const value = ctx.store.get(toStr(arg));
    if (value === null) {
      ctx.stats.keyspaceMisses += 1;
      items.push(resp.nullBulk);
    } else {
      ctx.stats.keyspaceHits += 1;
      items.push(resp.bulk(value));
    }
  }
  return { reply: resp.array(items) };
}

function msetCommand(ctx: CommandContext, args: Buffer[]): HandlerOutput {
  if (args.length % 2 !== 0) {
    return err("ERR wrong number of arguments for 'mset' command");
  }
  for (let i = 1; i < args.length; i += 2) {
    if (args[i]!.length > MAX_VALUE_BYTES) {
      return err('ERR string exceeds maximum allowed size (proto-max-bulk-len)');
    }
  }
  for (let i = 0; i < args.length; i += 2) {
    ctx.store.set(toStr(args[i]!), args[i + 1]!);
  }
  return { ...ok(), propagate: [['MSET', ...args]] };
}

function msetNxCommand(ctx: CommandContext, args: Buffer[]): HandlerOutput {
  if (args.length % 2 !== 0) {
    return err("ERR wrong number of arguments for 'msetnx' command");
  }
  // All or nothing: if any key already exists, set none of them.
  for (let i = 0; i < args.length; i += 2) {
    if (ctx.store.has(toStr(args[i]!))) return { reply: resp.integer(0) };
  }
  for (let i = 1; i < args.length; i += 2) {
    if (args[i]!.length > MAX_VALUE_BYTES) {
      return err('ERR string exceeds maximum allowed size (proto-max-bulk-len)');
    }
  }
  for (let i = 0; i < args.length; i += 2) {
    ctx.store.set(toStr(args[i]!), args[i + 1]!);
  }
  // Propagate the unconditional effect, the way a winning SET NX logs a plain
  // SET; a plain MSET replays to the same keyspace.
  return { reply: resp.integer(1), propagate: [['MSET', ...args]] };
}

function getDelCommand(ctx: CommandContext, args: Buffer[]): HandlerOutput {
  const key = toStr(args[0]!);
  const value = ctx.store.get(key);
  if (value === null) {
    ctx.stats.keyspaceMisses += 1;
    return { reply: resp.nullBulk };
  }
  ctx.stats.keyspaceHits += 1;
  ctx.store.delete(key);
  return { reply: resp.bulk(value), propagate: [['DEL', key]] };
}

function getRangeCommand(ctx: CommandContext, args: Buffer[]): HandlerOutput {
  const startArg = parseInt64(toStr(args[1]!));
  const endArg = parseInt64(toStr(args[2]!));
  if (startArg === null || endArg === null) {
    return err('ERR value is not an integer or out of range');
  }

  const value = ctx.store.get(toStr(args[0]!));
  if (value === null) {
    ctx.stats.keyspaceMisses += 1;
    return { reply: resp.bulk('') };
  }
  ctx.stats.keyspaceHits += 1;

  const len = BigInt(value.length);
  let start = startArg;
  let end = endArg;
  // Negative indices count back from the end; both bounds are inclusive.
  if (start < 0n) start += len;
  if (end < 0n) end += len;
  if (start < 0n) start = 0n;
  if (end < 0n) end = 0n;
  if (end >= len) end = len - 1n;
  if (start > end || len === 0n) return { reply: resp.bulk('') };

  return { reply: resp.bulk(value.subarray(Number(start), Number(end) + 1)) };
}

function setRangeCommand(ctx: CommandContext, args: Buffer[]): HandlerOutput {
  const key = toStr(args[0]!);
  const offset = parseInt64(toStr(args[1]!));
  if (offset === null) return err('ERR value is not an integer or out of range');
  if (offset < 0n) return err('ERR offset is out of range');
  const patch = args[2]!;
  const existing = ctx.store.get(key);

  if (patch.length === 0) {
    // An empty patch is a no-op: report the current length and never create
    // the key, like Redis.
    return { reply: resp.integer(existing === null ? 0 : existing.length) };
  }

  if (offset + BigInt(patch.length) > BigInt(MAX_VALUE_BYTES)) {
    return err('ERR string exceeds maximum allowed size (proto-max-bulk-len)');
  }

  const offsetNum = Number(offset);
  const newLength = Math.max(existing === null ? 0 : existing.length, offsetNum + patch.length);
  const next = Buffer.alloc(newLength); // zero-filled, so any gap is null bytes
  if (existing !== null) existing.copy(next);
  patch.copy(next, offsetNum);
  ctx.store.set(key, next, { keepTtl: true });
  return {
    reply: resp.integer(next.length),
    propagate: [['SETRANGE', key, String(offsetNum), patch]],
  };
}

function incrByFloatCommand(ctx: CommandContext, args: Buffer[]): HandlerOutput {
  const key = toStr(args[0]!);
  const increment = parseFloat64(toStr(args[1]!));
  if (increment === null) return err('ERR value is not a valid float');

  const current = ctx.store.get(key);
  let base = 0;
  if (current !== null) {
    const parsed = parseFloat64(toStr(current));
    if (parsed === null) return err('ERR value is not a valid float');
    base = parsed;
  }

  const next = base + increment;
  if (!Number.isFinite(next)) return err('ERR increment would produce NaN or Infinity');

  const formatted = formatFloat(next);
  // Like INCR, a read-modify-write that preserves any existing TTL. Replay is
  // deterministic because the same formatting runs at write and load time.
  ctx.store.set(key, Buffer.from(formatted, 'latin1'), { keepTtl: true });
  return { reply: resp.bulk(formatted), propagate: [['INCRBYFLOAT', key, args[1]!]] };
}

/* ------------------------------------------------------------------ */
/* expiry commands                                                    */
/* ------------------------------------------------------------------ */

function expireGeneric(
  ctx: CommandContext,
  args: Buffer[],
  unit: 'seconds' | 'milliseconds',
  mode: 'relative' | 'absolute',
  commandName: string,
): HandlerOutput {
  const key = toStr(args[0]!);
  const amount = parseInt64(toStr(args[1]!));
  if (amount === null) return err('ERR value is not an integer or out of range');

  const ms = unit === 'seconds' ? amount * 1000n : amount;
  const now = ctx.clock();
  const deadline = mode === 'relative' ? BigInt(now) + ms : ms;
  if (deadline > BigInt(Number.MAX_SAFE_INTEGER) || deadline < BigInt(-Number.MAX_SAFE_INTEGER)) {
    return err(`ERR invalid expire time in '${commandName}' command`);
  }

  if (!ctx.store.has(key)) return { reply: resp.integer(0) };

  const deadlineMs = Number(deadline);
  if (deadlineMs <= now) {
    // Setting an expiry in the past deletes the key, like Redis.
    ctx.store.delete(key);
    return { reply: resp.integer(1), propagate: [['DEL', key]] };
  }

  ctx.store.setExpiry(key, deadlineMs);
  return { reply: resp.integer(1), propagate: [['PEXPIREAT', key, String(deadlineMs)]] };
}

function ttlGeneric(ctx: CommandContext, args: Buffer[], unit: 'seconds' | 'milliseconds'): HandlerOutput {
  const expireAt = ctx.store.getExpiry(toStr(args[0]!));
  if (expireAt === undefined) return { reply: resp.integer(-2) };
  if (expireAt === null) return { reply: resp.integer(-1) };
  const remainingMs = expireAt - ctx.clock();
  return {
    reply: resp.integer(unit === 'milliseconds' ? remainingMs : Math.round(remainingMs / 1000)),
  };
}

function persistCommand(ctx: CommandContext, args: Buffer[]): HandlerOutput {
  const key = toStr(args[0]!);
  if (!ctx.store.persist(key)) return { reply: resp.integer(0) };
  return { reply: resp.integer(1), propagate: [['PERSIST', key]] };
}

/* ------------------------------------------------------------------ */
/* keyspace commands                                                  */
/* ------------------------------------------------------------------ */

function keysCommand(ctx: CommandContext, args: Buffer[]): HandlerOutput {
  const pattern = toStr(args[0]!);
  const matches = ctx.store.keys().filter((key) => globMatch(pattern, key));
  return { reply: resp.array(matches.map((key) => resp.bulk(key))) };
}

function scanCommand(ctx: CommandContext, args: Buffer[]): HandlerOutput {
  const cursor = parseSafeInt(toStr(args[0]!));
  if (cursor === null || cursor < 0) return err('ERR invalid cursor');

  let pattern: string | null = null;
  let count = SCAN_DEFAULT_COUNT;
  for (let i = 1; i < args.length; i++) {
    const option = toStr(args[i]!).toUpperCase();
    const raw = args[i + 1];
    if (raw === undefined) return err('ERR syntax error');
    if (option === 'MATCH') {
      pattern = toStr(raw);
    } else if (option === 'COUNT') {
      const parsed = parseSafeInt(toStr(raw));
      if (parsed === null || parsed < 1) return err('ERR syntax error');
      count = parsed;
    } else {
      return err('ERR syntax error');
    }
    i += 1;
  }

  // The cursor is a plain index into the current key ordering. Keys written
  // or removed between SCAN calls may be missed or seen twice; see README.
  const allKeys = ctx.store.keys();
  const window = allKeys.slice(cursor, cursor + count);
  const nextCursor = cursor + count >= allKeys.length ? 0 : cursor + count;
  const selected = pattern === null ? window : window.filter((key) => globMatch(pattern!, key));

  return {
    reply: resp.array([
      resp.bulk(String(nextCursor)),
      resp.array(selected.map((key) => resp.bulk(key))),
    ]),
  };
}

function typeCommand(ctx: CommandContext, args: Buffer[]): HandlerOutput {
  const exists = ctx.store.has(toStr(args[0]!));
  return { reply: resp.simpleString(exists ? 'string' : 'none') };
}

function flushAllCommand(ctx: CommandContext, args: Buffer[]): HandlerOutput {
  const mode = args[0];
  if (mode !== undefined) {
    const option = toStr(mode).toUpperCase();
    if (option !== 'ASYNC' && option !== 'SYNC') return err('ERR syntax error');
  }
  ctx.store.clear();
  return { ...ok(), propagate: [['FLUSHALL']] };
}

function dbSizeCommand(ctx: CommandContext, _args: Buffer[]): HandlerOutput {
  ctx.store.purgeExpired();
  return { reply: resp.integer(ctx.store.size()) };
}

/* ------------------------------------------------------------------ */
/* server commands                                                    */
/* ------------------------------------------------------------------ */

function infoCommand(ctx: CommandContext, args: Buffer[]): HandlerOutput {
  const requested = new Set(args.map((arg) => toStr(arg).toLowerCase()));
  const all =
    requested.size === 0 || requested.has('all') || requested.has('default') || requested.has('everything');
  const wants = (section: string): boolean => all || requested.has(section);

  const { store, stats } = ctx;
  const lines: string[] = [];

  if (wants('server')) {
    lines.push(
      '# Server',
      `respite_version:${VERSION}`,
      `os:${os.platform()} ${os.release()} ${os.arch()}`,
      `process_id:${process.pid}`,
      `tcp_port:${ctx.port}`,
      `uptime_in_seconds:${Math.max(0, Math.floor((ctx.clock() - ctx.startedAt) / 1000))}`,
      '',
    );
  }

  if (wants('clients')) {
    lines.push('# Clients', `connected_clients:${ctx.connectedClients()}`, '');
  }

  if (wants('memory')) {
    lines.push(
      '# Memory',
      `used_memory:${store.usedMemory}`,
      `used_memory_human:${humanBytes(store.usedMemory)}`,
      `maxmemory:${ctx.maxmemory}`,
      `maxmemory_human:${humanBytes(ctx.maxmemory)}`,
      `maxmemory_policy:${ctx.maxmemory > 0 ? 'allkeys-lru' : 'noeviction'}`,
      '',
    );
  }

  if (wants('persistence')) {
    lines.push('# Persistence', `aof_enabled:${ctx.aof !== null ? 1 : 0}`, 'aof_rewrite_in_progress:0', '');
  }

  if (wants('stats')) {
    lines.push(
      '# Stats',
      `total_connections_received:${stats.totalConnections}`,
      `total_commands_processed:${stats.commandsProcessed}`,
      `keyspace_hits:${stats.keyspaceHits}`,
      `keyspace_misses:${stats.keyspaceMisses}`,
      `expired_keys:${store.expiredKeyCount}`,
      `evicted_keys:${store.evictedKeyCount}`,
      '',
    );
  }

  if (wants('keyspace')) {
    store.purgeExpired();
    lines.push('# Keyspace');
    if (store.size() > 0) {
      lines.push(`db0:keys=${store.size()},expires=${store.expiresSize()}`);
    }
    lines.push('');
  }

  return { reply: resp.bulk(lines.join('\r\n')) };
}

/**
 * COMMAND stub. redis-cli issues COMMAND DOCS on startup for hints; an empty
 * array keeps every client happy without shipping full command metadata.
 */
function commandCommand(_ctx: CommandContext, _args: Buffer[]): HandlerOutput {
  return { reply: resp.array([]) };
}

function quitCommand(_ctx: CommandContext, _args: Buffer[]): HandlerOutput {
  return { ...ok(), close: true };
}

function bgRewriteAofCommand(ctx: CommandContext, _args: Buffer[]): HandlerOutput {
  if (ctx.aof === null) {
    return err('ERR BGREWRITEAOF is not possible: append only mode is disabled');
  }
  ctx.aof.rewrite(ctx.store.snapshot());
  return { reply: resp.simpleString('Background append only file rewriting started') };
}

/* ------------------------------------------------------------------ */
/* dispatch table                                                     */
/* ------------------------------------------------------------------ */

const COMMANDS = new Map<string, CommandSpec>([
  ['PING', { minArgs: 0, maxArgs: 1, handler: pingCommand }],
  ['ECHO', { minArgs: 1, maxArgs: 1, handler: echoCommand }],
  ['SET', { minArgs: 2, maxArgs: 7, handler: setCommand }],
  ['GET', { minArgs: 1, maxArgs: 1, handler: getCommand }],
  ['GETDEL', { minArgs: 1, maxArgs: 1, handler: getDelCommand }],
  ['GETRANGE', { minArgs: 3, maxArgs: 3, handler: getRangeCommand }],
  ['SETRANGE', { minArgs: 3, maxArgs: 3, handler: setRangeCommand }],
  ['MGET', { minArgs: 1, maxArgs: -1, handler: mgetCommand }],
  ['MSET', { minArgs: 2, maxArgs: -1, handler: msetCommand }],
  ['MSETNX', { minArgs: 2, maxArgs: -1, handler: msetNxCommand }],
  ['DEL', { minArgs: 1, maxArgs: -1, handler: delCommand }],
  ['EXISTS', { minArgs: 1, maxArgs: -1, handler: existsCommand }],
  ['EXPIRE', { minArgs: 2, maxArgs: 2, handler: (ctx, args) => expireGeneric(ctx, args, 'seconds', 'relative', 'expire') }],
  ['PEXPIRE', { minArgs: 2, maxArgs: 2, handler: (ctx, args) => expireGeneric(ctx, args, 'milliseconds', 'relative', 'pexpire') }],
  ['EXPIREAT', { minArgs: 2, maxArgs: 2, handler: (ctx, args) => expireGeneric(ctx, args, 'seconds', 'absolute', 'expireat') }],
  ['PEXPIREAT', { minArgs: 2, maxArgs: 2, handler: (ctx, args) => expireGeneric(ctx, args, 'milliseconds', 'absolute', 'pexpireat') }],
  ['TTL', { minArgs: 1, maxArgs: 1, handler: (ctx, args) => ttlGeneric(ctx, args, 'seconds') }],
  ['PTTL', { minArgs: 1, maxArgs: 1, handler: (ctx, args) => ttlGeneric(ctx, args, 'milliseconds') }],
  ['PERSIST', { minArgs: 1, maxArgs: 1, handler: persistCommand }],
  ['INCR', { minArgs: 1, maxArgs: 1, handler: incrCommand }],
  ['DECR', { minArgs: 1, maxArgs: 1, handler: decrCommand }],
  ['INCRBY', { minArgs: 2, maxArgs: 2, handler: incrByCommand }],
  ['DECRBY', { minArgs: 2, maxArgs: 2, handler: decrByCommand }],
  ['INCRBYFLOAT', { minArgs: 2, maxArgs: 2, handler: incrByFloatCommand }],
  ['APPEND', { minArgs: 2, maxArgs: 2, handler: appendCommand }],
  ['STRLEN', { minArgs: 1, maxArgs: 1, handler: strlenCommand }],
  ['KEYS', { minArgs: 1, maxArgs: 1, handler: keysCommand }],
  ['SCAN', { minArgs: 1, maxArgs: 5, handler: scanCommand }],
  ['TYPE', { minArgs: 1, maxArgs: 1, handler: typeCommand }],
  ['FLUSHALL', { minArgs: 0, maxArgs: 1, handler: flushAllCommand }],
  ['DBSIZE', { minArgs: 0, maxArgs: 0, handler: dbSizeCommand }],
  ['INFO', { minArgs: 0, maxArgs: -1, handler: infoCommand }],
  ['COMMAND', { minArgs: 0, maxArgs: -1, handler: commandCommand }],
  ['QUIT', { minArgs: 0, maxArgs: 0, handler: quitCommand }],
  ['BGREWRITEAOF', { minArgs: 0, maxArgs: 0, handler: bgRewriteAofCommand }],
]);

/** Names of all implemented commands, for docs and tests. */
export function commandNames(): string[] {
  return [...COMMANDS.keys()];
}
