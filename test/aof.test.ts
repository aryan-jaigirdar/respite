import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine.js';
import { decodeOne, type Reply } from './helpers/resp.js';

let dir: string;
let openEngines: Engine[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'respite-aof-'));
  openEngines = [];
});

afterEach(() => {
  for (const engine of openEngines) engine.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

interface AofHarness {
  engine: Engine;
  run: (...args: string[]) => Reply;
}

function openEngine(file: string, clock: { now: number }, maxmemory = 0): AofHarness {
  const engine = new Engine({
    appendonly: path.join(dir, file),
    clock: () => clock.now,
    maxmemory,
  });
  engine.open();
  openEngines.push(engine);
  const run = (...args: string[]): Reply =>
    decodeOne(engine.execute(args.map((arg) => Buffer.from(arg, 'latin1'))).reply);
  return { engine, run };
}

describe('AOF write and replay', () => {
  it('replays a mixed mutation history into the same state', () => {
    const clock = { now: 1000 };
    const first = openEngine('data.aof', clock);
    first.run('SET', 'a', '1');
    first.run('INCR', 'a');
    first.run('SET', 'b', 'hello');
    first.run('APPEND', 'b', ' world');
    first.run('SET', 'c', 'temp');
    first.run('DEL', 'c');
    first.run('SET', 'd', 'keep', 'NX');
    first.engine.close();

    const second = openEngine('data.aof', clock);
    expect(second.run('GET', 'a')).toBe('2');
    expect(second.run('GET', 'b')).toBe('hello world');
    expect(second.run('GET', 'c')).toBeNull();
    expect(second.run('GET', 'd')).toBe('keep');
    expect(second.run('DBSIZE')).toBe(3);
  });

  it('reads that do not mutate are not logged', () => {
    const clock = { now: 1000 };
    const harness = openEngine('reads.aof', clock);
    harness.run('SET', 'a', '1');
    harness.run('GET', 'a');
    harness.run('EXISTS', 'a');
    harness.run('TTL', 'a');
    harness.run('KEYS', '*');
    harness.engine.close();

    const content = fs.readFileSync(path.join(dir, 'reads.aof'), 'latin1');
    expect(content).toContain('SET');
    expect(content).not.toContain('GET');
    expect(content).not.toContain('EXISTS');
    expect(content).not.toContain('KEYS');
  });

  it('failed conditional SETs are not logged', () => {
    const clock = { now: 1000 };
    const harness = openEngine('nx.aof', clock);
    harness.run('SET', 'a', 'first');
    harness.run('SET', 'a', 'second', 'NX'); // fails, must not be logged
    harness.engine.close();

    const second = openEngine('nx.aof', clock);
    expect(second.run('GET', 'a')).toBe('first');
  });

  it('normalizes relative expiries to absolute PEXPIREAT', () => {
    const clock = { now: 50_000 };
    const harness = openEngine('ttl.aof', clock);
    harness.run('SET', 'k', 'v', 'PX', '5000');
    harness.run('SET', 'j', 'v');
    harness.run('EXPIRE', 'j', '60');
    harness.engine.close();

    const content = fs.readFileSync(path.join(dir, 'ttl.aof'), 'latin1');
    expect(content).toContain('PEXPIREAT');
    expect(content).not.toContain('EXPIRE\r'); // only the absolute form is stored
    expect(content).not.toContain('PX');

    // Replay at the same instant: full TTL remains.
    const sameTime = openEngine('ttl.aof', { now: 50_000 });
    expect(sameTime.run('PTTL', 'k')).toBe(5000);
    expect(sameTime.run('TTL', 'j')).toBe(60);
    sameTime.engine.close();

    // Replay long after the deadline: the keys are gone.
    const muchLater = openEngine('ttl.aof', { now: 50_000 + 120_000 });
    expect(muchLater.run('GET', 'k')).toBeNull();
    expect(muchLater.run('GET', 'j')).toBeNull();
  });

  it('logs a DEL when a key expires, so replay converges', () => {
    const clock = { now: 0 };
    const harness = openEngine('expired.aof', clock);
    harness.run('SET', 'k', 'v', 'PX', '100');
    clock.now = 200;
    expect(harness.run('GET', 'k')).toBeNull(); // lazy expiry fires here
    harness.engine.close();

    // Replay with the clock rewound to before the deadline: without the DEL
    // record the key would resurrect.
    const rewound = openEngine('expired.aof', { now: 0 });
    expect(rewound.run('GET', 'k')).toBeNull();
  });

  it('logs a DEL when a key is evicted, so replay converges', () => {
    const clock = { now: 1000 };
    const capacity = (64 + 6) * 2; // two entries of 2-byte key + 4-byte value
    const small = openEngine('evict.aof', clock, capacity);
    small.run('SET', 'k1', 'aaaa');
    small.run('SET', 'k2', 'aaaa');
    small.run('SET', 'k3', 'aaaa'); // evicts k1
    expect(small.engine.store.evictedKeyCount).toBe(1);
    small.engine.close();

    // Reopen with no memory limit: the evicted key must stay gone.
    const roomy = openEngine('evict.aof', clock, 0);
    expect(roomy.run('GET', 'k1')).toBeNull();
    expect(roomy.run('GET', 'k2')).toBe('aaaa');
    expect(roomy.run('GET', 'k3')).toBe('aaaa');
  });

  it('replays FLUSHALL and PERSIST', () => {
    const clock = { now: 1000 };
    const first = openEngine('flush.aof', clock);
    first.run('SET', 'a', '1');
    first.run('FLUSHALL');
    first.run('SET', 'b', '2', 'EX', '100');
    first.run('PERSIST', 'b');
    first.engine.close();

    const second = openEngine('flush.aof', clock);
    expect(second.run('GET', 'a')).toBeNull();
    expect(second.run('GET', 'b')).toBe('2');
    expect(second.run('TTL', 'b')).toBe(-1);
  });

  it('replays MSET as a multi-key write', () => {
    const clock = { now: 1000 };
    const first = openEngine('mset.aof', clock);
    first.run('MSET', 'a', '1', 'b', '2', 'c', '3');
    first.run('SET', 'b', 'overwritten');
    first.engine.close();

    const second = openEngine('mset.aof', clock);
    expect(second.run('MGET', 'a', 'b', 'c')).toEqual(['1', 'overwritten', '3']);
  });

  it('replays a winning MSETNX and drops a losing one', () => {
    const clock = { now: 1000 };
    const first = openEngine('msetnx.aof', clock);
    first.run('MSETNX', 'a', '1', 'b', '2');
    first.run('MSETNX', 'a', 'x', 'c', '3'); // loses: a already exists, logs nothing
    first.engine.close();

    const content = fs.readFileSync(path.join(dir, 'msetnx.aof'), 'latin1');
    expect(content).toContain('MSET'); // the winning call is stored as a plain MSET
    expect(content).not.toContain('MSETNX'); // the conditional form is never written

    const second = openEngine('msetnx.aof', clock);
    expect(second.run('GET', 'a')).toBe('1');
    expect(second.run('GET', 'b')).toBe('2');
    expect(second.run('GET', 'c')).toBeNull();
  });

  it('replays GETDEL as a delete', () => {
    const clock = { now: 1000 };
    const first = openEngine('getdel.aof', clock);
    first.run('SET', 'k', 'v');
    expect(first.run('GETDEL', 'k')).toBe('v');
    first.engine.close();

    const second = openEngine('getdel.aof', clock);
    expect(second.run('GET', 'k')).toBeNull();
    expect(second.run('DBSIZE')).toBe(0);
  });

  it('replays SETRANGE, padding included', () => {
    const clock = { now: 1000 };
    const first = openEngine('setrange.aof', clock);
    first.run('SET', 'k', 'Hello World');
    first.run('SETRANGE', 'k', '6', 'Redis');
    first.run('SETRANGE', 'pad', '5', 'Hi');
    first.engine.close();

    const second = openEngine('setrange.aof', clock);
    expect(second.run('GET', 'k')).toBe('Hello Redis');
    expect(second.run('STRLEN', 'pad')).toBe(7);
    expect(second.run('GETRANGE', 'pad', '5', '6')).toBe('Hi');
  });

  it('replays INCRBYFLOAT and preserves its TTL', () => {
    const clock = { now: 50_000 };
    const first = openEngine('incrbyfloat.aof', clock);
    first.run('SET', 'k', '10.5', 'EX', '100');
    expect(first.run('INCRBYFLOAT', 'k', '0.1')).toBe('10.6');
    first.run('INCRBYFLOAT', 'counter', '3.0e3'); // fresh key, no TTL
    first.engine.close();

    const second = openEngine('incrbyfloat.aof', { now: 50_000 });
    expect(second.run('GET', 'k')).toBe('10.6');
    expect(second.run('TTL', 'k')).toBe(100);
    expect(second.run('GET', 'counter')).toBe('3000');
  });

  it('does not log MGET or GETRANGE reads', () => {
    const clock = { now: 1000 };
    const harness = openEngine('string-reads.aof', clock);
    harness.run('SET', 'a', 'hello');
    harness.run('MGET', 'a', 'b');
    harness.run('GETRANGE', 'a', '0', '2');
    harness.engine.close();

    const content = fs.readFileSync(path.join(dir, 'string-reads.aof'), 'latin1');
    expect(content).toContain('SET');
    expect(content).not.toContain('MGET');
    expect(content).not.toContain('GETRANGE');
  });

  it('starts empty when the AOF does not exist yet', () => {
    const clock = { now: 1000 };
    const harness = openEngine('fresh.aof', clock);
    expect(harness.run('DBSIZE')).toBe(0);
    expect(harness.run('SET', 'a', '1')).toBe('OK');
  });
});

describe('BGREWRITEAOF', () => {
  it('compacts the file and preserves state and TTLs', () => {
    const clock = { now: 10_000 };
    const file = path.join(dir, 'rewrite.aof');
    const harness = openEngine('rewrite.aof', clock);
    for (let i = 0; i < 200; i++) harness.run('INCR', 'counter');
    harness.run('SET', 'session', 'abc', 'EX', '3600');
    harness.run('SET', 'gone', 'x');
    harness.run('DEL', 'gone');

    const before = fs.statSync(file).size;
    expect(harness.run('BGREWRITEAOF')).toBe('Background append only file rewriting started');
    const after = fs.statSync(file).size;
    expect(after).toBeLessThan(before / 4);

    // Appends after a rewrite land in the new file.
    harness.run('SET', 'post', 'rewrite');
    harness.engine.close();

    const second = openEngine('rewrite.aof', clock);
    expect(second.run('GET', 'counter')).toBe('200');
    expect(second.run('GET', 'session')).toBe('abc');
    expect(second.run('TTL', 'session')).toBe(3600);
    expect(second.run('GET', 'gone')).toBeNull();
    expect(second.run('GET', 'post')).toBe('rewrite');
    expect(second.run('DBSIZE')).toBe(3);
  });

  it('rewrites an empty dataset to an empty file', () => {
    const clock = { now: 10_000 };
    const file = path.join(dir, 'empty.aof');
    const harness = openEngine('empty.aof', clock);
    harness.run('SET', 'a', '1');
    harness.run('FLUSHALL');
    harness.run('BGREWRITEAOF');
    expect(fs.statSync(file).size).toBe(0);
  });
});

describe('AOF robustness', () => {
  it('tolerates a torn final write and truncates it away', () => {
    const clock = { now: 1000 };
    const file = path.join(dir, 'torn.aof');
    const first = openEngine('torn.aof', clock);
    first.run('SET', 'a', '1');
    first.run('SET', 'b', '2');
    first.engine.close();

    const intactSize = fs.statSync(file).size;
    fs.appendFileSync(file, '*3\r\n$3\r\nSET\r\n$1\r\nc'); // torn mid-command

    const second = new Engine({ appendonly: file, clock: () => clock.now });
    const opened = second.open();
    openEngines.push(second);
    expect(opened.replayedCommands).toBe(2);
    expect(opened.truncatedBytes).toBeGreaterThan(0);
    expect(fs.statSync(file).size).toBe(intactSize);

    const run = (...args: string[]): Reply =>
      decodeOne(second.execute(args.map((arg) => Buffer.from(arg, 'latin1'))).reply);
    expect(run('GET', 'a')).toBe('1');
    expect(run('GET', 'c')).toBeNull();
    run('SET', 'c', '3'); // appends must stay parseable after truncation
    second.close();

    const third = openEngine('torn.aof', clock);
    expect(third.run('GET', 'c')).toBe('3');
  });

  it('refuses to load a corrupt file', () => {
    const file = path.join(dir, 'corrupt.aof');
    fs.writeFileSync(file, '*2\r\n+OK\r\n$1\r\na\r\n'); // '+' is not valid in a command array
    const engine = new Engine({ appendonly: file });
    expect(() => engine.open()).toThrow(/bad file format/);
  });

  it('refuses to load a file that replays with an error', () => {
    const file = path.join(dir, 'badcmd.aof');
    fs.writeFileSync(file, '*1\r\n$7\r\nNOTACMD\r\n');
    const engine = new Engine({ appendonly: file });
    expect(() => engine.open()).toThrow(/AOF replay failed/);
  });
});
