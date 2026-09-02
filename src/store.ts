/**
 * The keyspace: a map of string keys to binary string values, with optional
 * per-key expiry, approximate memory accounting, and LRU eviction.
 *
 * Design notes:
 *
 * - Keys are decoded as latin1 strings (a byte-faithful 1:1 mapping), values
 *   stay raw Buffers, so the store is binary safe end to end.
 * - Expiry is lazy first: any lookup of an expired key removes it before the
 *   caller sees it. An {@link ExpirySweeper} additionally samples keys with a
 *   TTL in the background so unread keys are reclaimed too.
 * - Recency is tracked with an intrusive doubly-linked list; each entry holds
 *   its own node, so touch/evict are O(1).
 * - Memory usage is an estimate: key bytes + value bytes + a fixed per-entry
 *   overhead standing in for Map/list/expiry bookkeeping. When a maxmemory
 *   limit is set and the estimate exceeds it, least recently used keys are
 *   evicted until usage fits.
 *
 * The clock is injected so tests can drive time deterministically.
 */

import { LruList, type LruNode } from './lru.js';

export interface StoreOptions {
  /** Memory ceiling in bytes; 0 disables eviction. */
  maxmemory?: number;
  /** Millisecond clock, injectable for tests. Defaults to Date.now. */
  clock?: () => number;
}

export interface StoreEntrySnapshot {
  key: string;
  value: Buffer;
  expireAt: number | null;
}

interface Entry {
  value: Buffer;
  /** Absolute expiry timestamp in ms, or null when the key never expires. */
  expireAt: number | null;
  node: LruNode<string>;
}

type RemovalReason = 'deleted' | 'expired' | 'evicted';

/**
 * Estimated fixed cost of one entry beyond its key and value bytes (map slot,
 * list node, expiry bookkeeping). Deliberately coarse; see README.
 */
export const ENTRY_OVERHEAD_BYTES = 64;

export class Store {
  /** Keys removed because their TTL elapsed. Surfaced by INFO. */
  expiredKeyCount = 0;
  /** Keys removed by the maxmemory LRU policy. Surfaced by INFO. */
  evictedKeyCount = 0;

  /** Invoked after a key is evicted by the LRU policy (used to log AOF DELs). */
  onEvict: ((key: string) => void) | null = null;
  /** Invoked after a key is removed because it expired. */
  onExpire: ((key: string) => void) | null = null;

  maxmemory: number;
  readonly clock: () => number;

  private readonly entries = new Map<string, Entry>();
  /** Keys that currently have an expiry set; the sweeper samples from here. */
  private readonly expires = new Set<string>();
  private readonly lru = new LruList<string>();
  private usedBytes = 0;

  constructor(options: StoreOptions = {}) {
    this.maxmemory = options.maxmemory ?? 0;
    this.clock = options.clock ?? Date.now;
  }

  get usedMemory(): number {
    return this.usedBytes;
  }

  /** Number of live entries. May include expired keys not yet purged. */
  size(): number {
    return this.entries.size;
  }

  /** Number of live entries that have an expiry set. */
  expiresSize(): number {
    return this.expires.size;
  }

  /** Reads a value, refreshing its LRU position. Returns null if absent. */
  get(key: string): Buffer | null {
    const entry = this.lookup(key);
    if (entry === null) return null;
    this.lru.moveToFront(entry.node);
    return entry.value;
  }

  has(key: string): boolean {
    return this.lookup(key) !== null;
  }

  /**
   * Writes a value. By default any previous expiry is discarded (the SET
   * contract); `keepTtl` preserves it for read-modify-write commands such as
   * INCR and APPEND.
   */
  set(key: string, value: Buffer, options: { expireAt?: number | null; keepTtl?: boolean } = {}): void {
    let existing = this.entries.get(key) ?? null;
    if (existing !== null && this.isExpired(existing)) {
      this.removeKey(key, existing, 'expired');
      existing = null;
    }

    if (existing !== null) {
      this.usedBytes += value.length - existing.value.length;
      existing.value = value;
      this.lru.moveToFront(existing.node);
      if (!options.keepTtl) {
        this.applyExpiry(key, existing, options.expireAt ?? null);
      }
    } else {
      const entry: Entry = { value, expireAt: null, node: this.lru.pushFront(key) };
      this.entries.set(key, entry);
      this.usedBytes += ENTRY_OVERHEAD_BYTES + key.length + value.length;
      this.applyExpiry(key, entry, options.expireAt ?? null);
    }

    this.evictIfNeeded();
  }

  /** Removes a key. Returns false for missing keys and expired ones. */
  delete(key: string): boolean {
    const entry = this.entries.get(key);
    if (entry === undefined) return false;
    if (this.isExpired(entry)) {
      this.removeKey(key, entry, 'expired');
      return false;
    }
    this.removeKey(key, entry, 'deleted');
    return true;
  }

  /**
   * Expiry timestamp for a key: a number (absolute ms), null when the key has
   * no expiry, or undefined when the key does not exist.
   */
  getExpiry(key: string): number | null | undefined {
    const entry = this.lookup(key);
    if (entry === null) return undefined;
    return entry.expireAt;
  }

  /**
   * Sets an absolute expiry on an existing key. The caller is responsible for
   * timestamps in the past (Redis semantics: delete instead).
   */
  setExpiry(key: string, expireAt: number): boolean {
    const entry = this.lookup(key);
    if (entry === null) return false;
    this.applyExpiry(key, entry, expireAt);
    return true;
  }

  /** Clears the expiry of a key. Returns true only if one was set. */
  persist(key: string): boolean {
    const entry = this.lookup(key);
    if (entry === null || entry.expireAt === null) return false;
    this.applyExpiry(key, entry, null);
    return true;
  }

  /** All live (non-expired) keys, purging expired ones encountered. */
  keys(): string[] {
    const result: string[] = [];
    for (const [key, entry] of this.entries) {
      if (this.isExpired(entry)) {
        this.removeKey(key, entry, 'expired');
        continue;
      }
      result.push(key);
    }
    return result;
  }

  /** Removes every expired key. Used where an exact count matters (DBSIZE). */
  purgeExpired(): void {
    for (const key of [...this.expires]) {
      this.lookup(key); // lookup removes the entry if it is expired
    }
  }

  /**
   * One active-expiry cycle: examine up to `sampleSize` random keys that have
   * a TTL and purge the expired ones. Returns how many were examined and how
   * many were purged, so the sweeper can decide whether to run another cycle.
   */
  purgeExpiredSample(sampleSize: number): { sampled: number; expired: number } {
    if (this.expires.size === 0 || sampleSize <= 0) return { sampled: 0, expired: 0 };

    const candidates = [...this.expires];
    const sampled = Math.min(sampleSize, candidates.length);
    let expired = 0;
    // Partial Fisher-Yates: the first `sampled` slots become a uniform sample.
    for (let i = 0; i < sampled; i++) {
      const j = i + Math.floor(Math.random() * (candidates.length - i));
      const tmp = candidates[i]!;
      candidates[i] = candidates[j]!;
      candidates[j] = tmp;

      const key = candidates[i]!;
      const entry = this.entries.get(key);
      if (entry !== undefined && this.isExpired(entry)) {
        this.removeKey(key, entry, 'expired');
        expired += 1;
      }
    }
    return { sampled, expired };
  }

  /** Live entries for AOF rewrite. Skips expired keys without purging. */
  *snapshot(): IterableIterator<StoreEntrySnapshot> {
    for (const [key, entry] of this.entries) {
      if (this.isExpired(entry)) continue;
      yield { key, value: entry.value, expireAt: entry.expireAt };
    }
  }

  clear(): void {
    this.entries.clear();
    this.expires.clear();
    this.lru.clear();
    this.usedBytes = 0;
  }

  /** Keys from most to least recently used. Intended for tests. */
  recencyOrder(): string[] {
    return this.lru.toArray();
  }

  private lookup(key: string): Entry | null {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    if (this.isExpired(entry)) {
      this.removeKey(key, entry, 'expired');
      return null;
    }
    return entry;
  }

  private isExpired(entry: Entry): boolean {
    return entry.expireAt !== null && entry.expireAt <= this.clock();
  }

  private applyExpiry(key: string, entry: Entry, expireAt: number | null): void {
    entry.expireAt = expireAt;
    if (expireAt === null) {
      this.expires.delete(key);
    } else {
      this.expires.add(key);
    }
  }

  private removeKey(key: string, entry: Entry, reason: RemovalReason): void {
    this.entries.delete(key);
    this.expires.delete(key);
    this.lru.remove(entry.node);
    this.usedBytes -= ENTRY_OVERHEAD_BYTES + key.length + entry.value.length;
    if (reason === 'expired') {
      this.expiredKeyCount += 1;
      this.onExpire?.(key);
    } else if (reason === 'evicted') {
      this.evictedKeyCount += 1;
      this.onEvict?.(key);
    }
  }

  /**
   * Enforces maxmemory by evicting from the LRU tail. Note that a single
   * entry larger than the limit evicts everything, itself included; the
   * ceiling always wins. This mirrors an allkeys-lru cache more than Redis,
   * which would answer OOM errors instead. Documented in the README.
   */
  private evictIfNeeded(): void {
    if (this.maxmemory <= 0) return;
    while (this.usedBytes > this.maxmemory) {
      const victim = this.lru.leastRecent;
      if (victim === undefined) break;
      const entry = this.entries.get(victim);
      if (entry === undefined) break; // defensive: list and map disagree
      this.removeKey(victim, entry, 'evicted');
    }
  }
}
