/**
 * Active expiration, modeled on Redis' activeExpireCycle.
 *
 * Lazy expiration alone never reclaims keys nobody reads again. The sweeper
 * periodically samples random keys that have a TTL and purges the expired
 * ones. If a large fraction of the sample was expired, it immediately samples
 * again (bounded by `maxCyclesPerRun`), so a backlog of dead keys drains in a
 * few ticks without ever scanning the whole keyspace in one go.
 */

import type { Store } from './store.js';

export interface ExpirySweeperOptions {
  /** How often a sweep runs. Redis uses 100 ms (10 Hz). */
  intervalMs?: number;
  /** Keys examined per cycle. */
  sampleSize?: number;
  /** If more than this fraction of a sample was expired, sample again. */
  repeatThreshold?: number;
  /** Upper bound on back-to-back cycles within one tick. */
  maxCyclesPerRun?: number;
}

export class ExpirySweeper {
  private readonly intervalMs: number;
  private readonly sampleSize: number;
  private readonly repeatThreshold: number;
  private readonly maxCyclesPerRun: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: Store,
    options: ExpirySweeperOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 100;
    this.sampleSize = options.sampleSize ?? 20;
    this.repeatThreshold = options.repeatThreshold ?? 0.25;
    this.maxCyclesPerRun = options.maxCyclesPerRun ?? 16;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.run(), this.intervalMs);
    // Never keep the process alive just to expire keys.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** One sweep. Public so tests can drive it without timers. */
  run(): number {
    let totalExpired = 0;
    for (let cycle = 0; cycle < this.maxCyclesPerRun; cycle++) {
      const { sampled, expired } = this.store.purgeExpiredSample(this.sampleSize);
      totalExpired += expired;
      if (sampled === 0 || expired / sampled <= this.repeatThreshold) break;
    }
    return totalExpired;
  }
}
