/**
 * The engine ties the store, command table, expiry sweeper, and append-only
 * file together, with no networking. server.ts feeds it decoded commands from
 * sockets; tests feed it commands directly.
 */

import fs from 'node:fs';
import { Store } from './store.js';
import { ServerStats } from './stats.js';
import { ExpirySweeper, type ExpirySweeperOptions } from './expiry.js';
import { AppendOnlyFile, loadAof, type AofLoadResult } from './aof.js';
import { execute, type CommandContext, type CommandResult } from './commands.js';

export interface EngineOptions {
  /** Memory ceiling in bytes; 0 disables eviction. */
  maxmemory?: number;
  /** Path to the append-only file; null/undefined disables persistence. */
  appendonly?: string | null;
  /** Millisecond clock, injectable for tests. */
  clock?: () => number;
  /** Advertised port for INFO; the server updates it after listen(). */
  port?: number;
  sweeper?: ExpirySweeperOptions;
  logger?: (message: string) => void;
}

export interface EngineOpenResult {
  replayedCommands: number;
  truncatedBytes: number;
}

export class Engine {
  readonly store: Store;
  readonly stats = new ServerStats();
  readonly clock: () => number;

  /** Overridden by the server so INFO can report live connections. */
  connectedClients: () => number = () => 0;

  private readonly ctx: CommandContext;
  private readonly sweeper: ExpirySweeper;
  private readonly aofPath: string | null;
  private readonly logger: (message: string) => void;
  private aof: AppendOnlyFile | null = null;
  private opened = false;
  private pendingEvictions: Set<string> | null = null;

  constructor(options: EngineOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.aofPath = options.appendonly ?? null;
    this.logger = options.logger ?? (() => undefined);
    this.store = new Store({ maxmemory: options.maxmemory ?? 0, clock: this.clock });
    this.sweeper = new ExpirySweeper(this.store, options.sweeper ?? {});
    this.ctx = {
      store: this.store,
      stats: this.stats,
      clock: this.clock,
      startedAt: this.clock(),
      port: options.port ?? 0,
      maxmemory: options.maxmemory ?? 0,
      aof: null,
      connectedClients: () => this.connectedClients(),
    };
  }

  get aofEnabled(): boolean {
    return this.aof !== null;
  }

  /**
   * Replays the AOF (if configured), opens it for appending, wires eviction
   * and expiry propagation, and starts the active expiry sweeper.
   */
  open(): EngineOpenResult {
    if (this.opened) throw new Error('engine already opened');
    this.opened = true;

    let replayedCommands = 0;
    let truncatedBytes = 0;

    if (this.aofPath !== null) {
      // Replay with ctx.aof still null so nothing is re-appended, and with
      // propagation callbacks unwired so replay-time expiry stays silent.
      // The AOF records the actual eviction decisions. Reads are not logged,
      // so replay cannot reconstruct LRU order and must not make its own
      // eviction decisions while applying the command history.
      const memoryLimit = this.store.maxmemory;
      const expiryEnabled = this.store.expiryEnabled;
      this.store.maxmemory = 0;
      // A deadline may have passed by restart, but later historical INCR,
      // APPEND or PERSIST records must still see the original value/TTL.
      // Live expiry already contributed DEL records to that history.
      this.store.expiryEnabled = false;
      let result: AofLoadResult;
      try {
        result = loadAof(this.aofPath, (args) => {
          const outcome = execute(this.ctx, args, { fromAof: true });
          if (outcome.reply[0] === 0x2d /* '-' */) {
            const message = outcome.reply.toString('latin1', 1).trim();
            throw new Error(`AOF replay failed at command ${replayedCommands + 1}: ${message}`);
          }
          replayedCommands += 1;
        });
      } finally {
        this.store.maxmemory = memoryLimit;
        this.store.expiryEnabled = expiryEnabled;
      }
      truncatedBytes = result.truncatedBytes;

      if (truncatedBytes > 0) {
        // Torn final write: drop the partial tail so future appends stay
        // parseable, mirroring Redis' aof-load-truncated behavior.
        this.logger(
          `warning: AOF ${this.aofPath} ends with ${truncatedBytes} bytes of a torn command, truncating`,
        );
        fs.truncateSync(this.aofPath, result.validBytes);
      }

      this.aof = new AppendOnlyFile(this.aofPath);
      this.ctx.aof = this.aof;

      // From here on, keys removed by eviction or expiry are logged as DELs
      // so a replay converges to the same keyspace.
      const propagateDel = (key: string): void => {
        this.aof?.append(['DEL', key]);
      };
      this.store.onEvict = (key) => {
        // A write can evict itself, or an earlier pair in MSET. Its DEL
        // must follow the write record or replay would resurrect the key.
        if (this.pendingEvictions !== null) this.pendingEvictions.add(key);
        else propagateDel(key);
      };
      this.store.onExpire = propagateDel;
      // Apply the real startup clock only after all historical mutations.
      // Remove expired entries before live ones compete for maxmemory.
      this.store.purgeExpired();
      // A new, smaller limit applies to the reconstructed dataset. Its
      // startup evictions are recorded so a later restart also keeps them.
      this.store.enforceMemoryLimit();
    }

    this.sweeper.start();
    return { replayedCommands, truncatedBytes };
  }

  execute(args: Buffer[]): CommandResult {
    const evicted = new Set<string>();
    this.pendingEvictions = evicted;
    try {
      return execute(this.ctx, args);
    } finally {
      this.pendingEvictions = null;
      for (const key of evicted) {
        // A later pair in the same MSET can reinsert an evicted key. Log
        // only keys absent from the final state of the command.
        if (!this.store.has(key)) this.aof?.append(['DEL', key]);
      }
    }
  }

  setAdvertisedPort(port: number): void {
    this.ctx.port = port;
  }

  /** Stops the sweeper and fsyncs + closes the AOF. Idempotent. */
  close(): void {
    this.sweeper.stop();
    if (this.aof !== null) {
      this.aof.close();
      this.aof = null;
      this.ctx.aof = null;
    }
  }
}
