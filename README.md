# respite

An in-memory key-value store that speaks the Redis wire protocol (RESP2), written in TypeScript with zero runtime dependencies. Point a real `redis-cli` at it and it just works.

```
$ respite --port 6380 --maxmemory 64mb --appendonly data.aof
respite 0.1.0 listening on 127.0.0.1:6380

$ redis-cli -p 6380
127.0.0.1:6380> set greeting "hello" EX 60
OK
127.0.0.1:6380> ttl greeting
(integer) 60
127.0.0.1:6380> incr visits
(integer) 1
```

## Why

This is a learning-the-internals project: how far can you get reimplementing Redis semantics in TypeScript on a single Node process? Quite far, it turns out. The interesting problems are all here in miniature:

- a streaming protocol parser that survives arbitrary TCP fragmentation,
- lazy plus sampled active expiration,
- an O(1) LRU built from a doubly-linked list and a map,
- append-only persistence with absolute-time normalization and compaction.

The zero-dependency constraint is deliberate. Everything, from argument parsing to glob matching, is implemented in this repository, so every moving part is readable in one sitting.

## Quickstart

Requires Node.js 20 or newer.

```
git clone <this repo> && cd respite
npm install        # dev dependencies only (typescript, vitest, tsx)
npm run build
npm start          # listens on 127.0.0.1:6380
```

Or during development:

```
npm run dev -- --port 6380 --maxmemory 64mb --appendonly data.aof
```

Flags:

| Flag | Meaning | Default |
| --- | --- | --- |
| `--port <port>` | TCP port to listen on | `6380` |
| `--host <host>` | Address to bind | `127.0.0.1` |
| `--maxmemory <size>` | Memory ceiling with LRU eviction (`64mb`, `1gb`, or plain bytes) | unlimited |
| `--appendonly <path>` | Enable append-only persistence to this file | disabled |
| `-h, --help` | Usage | |
| `-v, --version` | Version | |

Any RESP2 client works. `redis-cli -p 6380` is the easiest way to poke at it; the test suite ships its own tiny RESP client so the tests do not require redis-cli to be installed.

## Supported commands

Values are binary-safe strings. All names are case-insensitive.

| Command | Notes |
| --- | --- |
| `PING [msg]` | `PONG`, or echoes `msg` |
| `ECHO msg` | |
| `SET key value [EX s] [PX ms] [NX\|XX]` | Full option validation; plain SET clears any TTL |
| `GET key` | |
| `GETDEL key` | Returns the value and deletes the key |
| `GETRANGE key start end` | Inclusive substring with negative indexing; empty string for a missing key |
| `SETRANGE key offset value` | Overwrites from `offset`, zero-padding any gap with null bytes; returns the new length and preserves TTL |
| `MGET key [key ...]` | Array of values, null for each missing key |
| `MSET key value [key value ...]` | Sets every pair; errors on an odd argument count |
| `MSETNX key value [key value ...]` | Sets all and returns 1 only if none of the keys exist, otherwise 0 |
| `DEL key [key ...]` | Returns the number of keys removed |
| `EXISTS key [key ...]` | Counts repeats, like Redis |
| `INCR / DECR key` | Full signed 64-bit range via BigInt, preserves TTL |
| `INCRBY / DECRBY key n` | |
| `INCRBYFLOAT key increment` | Floating-point increment, preserves TTL; Redis-style formatting with no trailing zeros |
| `APPEND key value` | Returns new length, preserves TTL |
| `STRLEN key` | |
| `EXPIRE / PEXPIRE key n` | Non-positive TTL deletes the key and returns 1 |
| `EXPIREAT / PEXPIREAT key ts` | Absolute deadlines; also the AOF's internal form |
| `TTL / PTTL key` | `-1` no expiry, `-2` no key |
| `PERSIST key` | |
| `KEYS pattern` | Redis-style glob: `*`, `?`, `[a-z]`, `[^ab]`, `\` escapes |
| `SCAN cursor [MATCH pat] [COUNT n]` | Cursor-based iteration (see caveats below) |
| `TYPE key` | `string` or `none` |
| `FLUSHALL [ASYNC\|SYNC]` | The mode argument is accepted and ignored |
| `DBSIZE` | Excludes expired keys |
| `INFO [section ...]` | server, clients, memory, persistence, stats, keyspace |
| `COMMAND [...]` | Stub returning an empty array so redis-cli connects happily |
| `BGREWRITEAOF` | Synchronous compaction (see persistence below) |
| `QUIT` | |

## Design

### Streaming RESP parser

TCP is a byte stream with no message boundaries: one `data` event can carry half a command, three commands, or three and a half. The parser (`src/resp/parser.ts`) buffers input and repeatedly attempts to decode one command from the current position. Each attempt has exactly three outcomes:

1. a complete command, whose bytes are then consumed,
2. "incomplete", which leaves the buffer untouched until more bytes arrive,
3. a protocol error, which is reported to the client before the connection is closed, because the stream offset is no longer trustworthy.

Incomplete detection never consumes partial input, so a command split at any byte boundary parses identically to one delivered whole. The test suite proves this by replaying a command through every possible split point and byte-by-byte. Argument buffers are copied out of the network buffer, so retaining a value does not pin an entire socket chunk in memory.

Headers and inline lines have length ceilings (and bulk payloads honor the 512 MB `proto-max-bulk-len`), so a client that never sends a terminator cannot make the server buffer without bound. Lines that do not start with `*` fall back to inline parsing (whitespace-separated, no quoting), which keeps `telnet` sessions usable.

### LRU eviction

`--maxmemory` enables approximate memory accounting: each entry costs its key bytes plus value bytes plus a fixed 64-byte overhead standing in for map slot, list node, and expiry bookkeeping. Recency is an intrusive doubly-linked list (`src/lru.ts`); each store entry holds its own node, so reads, writes, and evictions are all O(1) with no scanning. `GET` and every write refresh recency; when usage exceeds the ceiling, keys are evicted from the tail (least recently used) until it fits, and each eviction is logged to the AOF as a `DEL` so replay converges.

One documented sharp edge: a single entry larger than maxmemory evicts everything, itself included. The ceiling always wins. Real Redis answers OOM errors instead; respite behaves like a strict cache.

### Expiry

Two mechanisms, same as Redis:

- **Lazy**: every lookup checks the entry's absolute deadline first and removes an expired key before the caller can observe it.
- **Active**: a sweeper (`src/expiry.ts`) runs 10 times per second, samples up to 20 random keys that have a TTL, and purges the expired ones. If more than 25 percent of a sample was expired it immediately samples again (bounded per tick), so a large backlog drains quickly without ever scanning the whole keyspace at once.

Deadlines are stored as absolute millisecond timestamps. The clock is injected throughout, which is why the TTL tests are fully deterministic instead of sleep-based.

### Append-only file

The AOF format is exactly the wire format: a flat sequence of RESP command arrays. Loading is just feeding the file through the same streaming parser used for sockets, which makes the format binary-safe for free and means the parser gets exercised by every persistence test too.

What gets written is normalized, not verbatim:

- `SET k v EX 10` is logged as `SET k v` plus `PEXPIREAT k <absolute ms>`, so replaying tomorrow does not restart the TTL.
- `EXPIRE`/`PEXPIRE`/`EXPIREAT` are all logged as `PEXPIREAT`.
- Keys removed by expiry or eviction are logged as `DEL`, so a replay under different memory settings or at a different time converges to the same keyspace.
- Deterministic commands (`INCR`, `APPEND`, `DEL`, ...) are logged as issued. Failed conditional writes (a `SET NX` that lost) log nothing.

`BGREWRITEAOF` compacts the file to one `SET` (plus optional `PEXPIREAT`) per live key. Despite the name it is synchronous: the snapshot is written to a temp file, fsynced, and atomically renamed over the old file, so a crash mid-rewrite can never leave a torn AOF in place. Durability is deliberately modest: appends go through the OS page cache and are fsynced on rewrite and graceful shutdown, roughly `appendfsync no`. A torn final command (process killed mid-write) is detected on load, warned about, and truncated away, mirroring `aof-load-truncated yes`.

### SCAN caveats

`SCAN` cursors are plain indexes into the current key ordering. Iteration always terminates and visits every key that existed for the whole scan if the keyspace is stable, but keys written or deleted mid-scan may be missed or seen twice. Real Redis has weaker-than-intuitive guarantees here as well; this implementation is simply upfront about its simpler ones.

## Performance

`npm run bench` drives a few representative workloads (SET, GET, INCR, and a mixed read/write) through a real socket and prints throughput and latency. See [BENCHMARKS.md](BENCHMARKS.md) for the harness, a recorded run, and the honest caveats.

## Development

```
npm run build      # tsc, strict settings, emits dist/
npm test           # vitest, 200+ tests, no external services needed
npm run test:coverage
npm run typecheck  # includes the test suite
npm run dev        # run from source via tsx
```

The tests cover parser fragmentation edge cases, every command's semantics, TTL behavior on a fake clock, LRU eviction order, AOF write/replay/rewrite round trips, and end-to-end runs over a real socket using the suite's own minimal RESP client.

## Limitations

Intentional scope cuts, not oversights:

- **Not for production.** It is a study of the mechanics, not a replacement for Redis.
- **Strings only.** No lists, hashes, sets, sorted sets, streams, or pub/sub. `TYPE` accordingly only ever answers `string` or `none`.
- **RESP2 only.** No `HELLO`, no RESP3 push types.
- **Single database.** No `SELECT`; `INFO` reports `db0` only.
- **Single-threaded.** Like Redis at heart, one event loop does everything; unlike Redis there are no io-threads or background rewrite processes.
- **No auth, no TLS, no replication, no cluster.** It binds to 127.0.0.1 by default for exactly this reason.
- **Approximate memory accounting.** Entry overhead is a flat constant, not a measured heap footprint.

## License

MIT, see [LICENSE](LICENSE).
