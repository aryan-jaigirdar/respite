import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/store.js';
import { ExpirySweeper } from '../src/expiry.js';
import { makeHarness } from './helpers/harness.js';
import { isErrorReply } from './helpers/resp.js';

describe('lazy expiration through commands', () => {
  it('an expired key reads as missing', () => {
    const { run, clock } = makeHarness();
    run('SET', 'k', 'v', 'PX', '100');
    expect(run('GET', 'k')).toBe('v');
    clock.now += 101;
    expect(run('GET', 'k')).toBeNull();
    expect(run('EXISTS', 'k')).toBe(0);
    expect(run('TYPE', 'k')).toBe('none');
  });

  it('expiring on access increments expired_keys', () => {
    const { run, clock, engine } = makeHarness();
    run('SET', 'k', 'v', 'PX', '100');
    clock.now += 200;
    run('GET', 'k');
    expect(engine.store.expiredKeyCount).toBe(1);
    expect(run('INFO', 'stats')).toContain('expired_keys:1');
  });

  it('TTL and PTTL report remaining time, -1, and -2', () => {
    const { run, clock } = makeHarness();
    expect(run('TTL', 'missing')).toBe(-2);
    expect(run('PTTL', 'missing')).toBe(-2);

    run('SET', 'k', 'v');
    expect(run('TTL', 'k')).toBe(-1);
    expect(run('PTTL', 'k')).toBe(-1);

    run('SET', 'k', 'v', 'PX', '10000');
    clock.now += 4000;
    expect(run('PTTL', 'k')).toBe(6000);
    expect(run('TTL', 'k')).toBe(6);
  });

  it('EXPIRE and PEXPIRE set a TTL on an existing key', () => {
    const { run } = makeHarness();
    run('SET', 'k', 'v');
    expect(run('EXPIRE', 'k', '30')).toBe(1);
    expect(run('TTL', 'k')).toBe(30);
    expect(run('PEXPIRE', 'k', '2500')).toBe(1);
    expect(run('PTTL', 'k')).toBe(2500);
    expect(run('EXPIRE', 'missing', '30')).toBe(0);
  });

  it('EXPIREAT and PEXPIREAT take absolute timestamps', () => {
    const { run, clock } = makeHarness();
    run('SET', 'k', 'v');
    const inTenSeconds = Math.floor((clock.now + 10_000) / 1000);
    expect(run('EXPIREAT', 'k', String(inTenSeconds))).toBe(1);
    expect(run('TTL', 'k')).toBe(10);

    expect(run('PEXPIREAT', 'k', String(clock.now + 500))).toBe(1);
    expect(run('PTTL', 'k')).toBe(500);
  });

  it('a non-positive TTL deletes the key immediately', () => {
    const { run } = makeHarness();
    run('SET', 'k', 'v');
    expect(run('EXPIRE', 'k', '0')).toBe(1);
    expect(run('EXISTS', 'k')).toBe(0);

    run('SET', 'k', 'v');
    expect(run('EXPIRE', 'k', '-5')).toBe(1);
    expect(run('EXISTS', 'k')).toBe(0);

    run('SET', 'k', 'v');
    expect(run('PEXPIREAT', 'k', '1')).toBe(1); // far in the past
    expect(run('EXISTS', 'k')).toBe(0);
  });

  it('rejects non-integer and absurd expire arguments', () => {
    const { run } = makeHarness();
    run('SET', 'k', 'v');
    const bad = run('EXPIRE', 'k', 'soon');
    expect(isErrorReply(bad) && bad.error).toBe('ERR value is not an integer or out of range');
    const huge = run('EXPIRE', 'k', '99999999999999999999');
    expect(isErrorReply(huge) && huge.error).toBe('ERR value is not an integer or out of range');
  });

  it('PERSIST removes a TTL exactly once', () => {
    const { run } = makeHarness();
    run('SET', 'k', 'v', 'EX', '100');
    expect(run('PERSIST', 'k')).toBe(1);
    expect(run('TTL', 'k')).toBe(-1);
    expect(run('PERSIST', 'k')).toBe(0);
    expect(run('PERSIST', 'missing')).toBe(0);
  });

  it('EXPIRE on an already expired key reports 0', () => {
    const { run, clock } = makeHarness();
    run('SET', 'k', 'v', 'PX', '100');
    clock.now += 200;
    expect(run('EXPIRE', 'k', '100')).toBe(0);
  });
});

describe('ExpirySweeper', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reclaims expired keys nobody reads', () => {
    let now = 0;
    const store = new Store({ clock: () => now });
    for (let i = 0; i < 50; i++) {
      store.set(`dead:${i}`, Buffer.from('v'), { expireAt: 100 });
    }
    for (let i = 0; i < 50; i++) {
      store.set(`live:${i}`, Buffer.from('v'));
    }

    now = 200;
    const sweeper = new ExpirySweeper(store, { sampleSize: 10 });
    // Every sample is 100% expired, so a single run keeps cycling until the
    // backlog is gone (bounded by maxCyclesPerRun, which 50 keys fit inside).
    const expired = sweeper.run();
    expect(expired).toBe(50);
    expect(store.size()).toBe(50);
    expect(store.expiredKeyCount).toBe(50);
    expect(store.expiresSize()).toBe(0);
  });

  it('leaves keys alone before their deadline', () => {
    let now = 0;
    const store = new Store({ clock: () => now });
    store.set('k', Buffer.from('v'), { expireAt: 1000 });
    const sweeper = new ExpirySweeper(store, { sampleSize: 10 });
    expect(sweeper.run()).toBe(0);
    expect(store.size()).toBe(1);
  });

  it('stops cycling when the expired ratio in a sample is low', () => {
    let now = 0;
    const store = new Store({ clock: () => now });
    for (let i = 0; i < 100; i++) {
      store.set(`k:${i}`, Buffer.from('v'), { expireAt: i < 5 ? 100 : 1_000_000 });
    }
    now = 200;
    const sweeper = new ExpirySweeper(store, { sampleSize: 20, maxCyclesPerRun: 1 });
    sweeper.run();
    // One cycle samples 20 of 100 keys; it cannot have purged more than the
    // 5 expired ones and must leave the live ones untouched.
    expect(store.size()).toBeGreaterThanOrEqual(95);
  });

  it('runs on its interval', () => {
    vi.useFakeTimers();
    let now = 0;
    const store = new Store({ clock: () => now });
    for (let i = 0; i < 10; i++) {
      store.set(`k:${i}`, Buffer.from('v'), { expireAt: 50 });
    }
    const sweeper = new ExpirySweeper(store, { intervalMs: 100, sampleSize: 20 });
    sweeper.start();
    sweeper.start(); // idempotent

    now = 60;
    vi.advanceTimersByTime(100);
    expect(store.size()).toBe(0);

    sweeper.stop();
    sweeper.stop(); // idempotent
    now = 1000;
    store.set('again', Buffer.from('v'), { expireAt: 1050 });
    now = 2000;
    vi.advanceTimersByTime(1000); // stopped: nothing runs
    expect(store.size()).toBe(1);
  });
});
