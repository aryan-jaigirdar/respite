/**
 * The engine ties the store, command table, expiry sweeper, and append-only
 * file together, with no networking. server.ts feeds it decoded commands from
 * sockets; tests feed it commands directly.
 */

import fs from 'node:fs';
import { Store } from './store.js';
import { ServerStats } from './stats.js';
import { ExpirySweeper, type ExpirySweeperOptions } from './expiry.js';
import { AppendOnlyFile, loadAof } from './aof.js';
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
      const result = loadAof(this.aofPath, (args) => {
        const outcome = execute(this.ctx, args, { fromAof: true });
        if (outcome.reply[0] === 0x2d /* '-' */) {
          const message = outcome.reply.toString('latin1', 1).trim();
          throw new Error(`AOF replay failed at command ${replayedCommands + 1}: ${message}`);
        }
        replayedCommands += 1;
      });
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
      this.store.onEvict = propagateDel;
      this.store.onExpire = propagateDel;
    }

    this.sweeper.start();
    return { replayedCommands, truncatedBytes };
  }

  execute(args: Buffer[]): CommandResult {
    return execute(this.ctx, args);
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
