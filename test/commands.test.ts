import { describe, expect, it } from 'vitest';
import { makeHarness } from './helpers/harness.js';
import { isErrorReply, type Reply } from './helpers/resp.js';

function errorOf(reply: Reply): string {
  if (!isErrorReply(reply)) throw new Error(`expected an error reply, got ${JSON.stringify(reply)}`);
  return reply.error;
}

describe('PING and ECHO', () => {
  it('PING replies PONG', () => {
    const { run } = makeHarness();
    expect(run('PING')).toBe('PONG');
  });

  it('PING with a message echoes it as a bulk string', () => {
    const { run } = makeHarness();
    expect(run('PING', 'hello')).toBe('hello');
  });

  it('ECHO returns its argument', () => {
    const { run } = makeHarness();
    expect(run('ECHO', 'hi there')).toBe('hi there');
  });

  it('command names are case-insensitive', () => {
    const { run } = makeHarness();
    expect(run('ping')).toBe('PONG');
    expect(run('PiNg')).toBe('PONG');
  });
});

describe('SET and GET', () => {
  it('sets and gets a value', () => {
    const { run } = makeHarness();
    expect(run('SET', 'k', 'v')).toBe('OK');
    expect(run('GET', 'k')).toBe('v');
  });

  it('overwrites an existing value', () => {
    const { run } = makeHarness();
    run('SET', 'k', 'v1');
    run('SET', 'k', 'v2');
    expect(run('GET', 'k')).toBe('v2');
  });

  it('GET on a missing key returns null', () => {
    const { run } = makeHarness();
    expect(run('GET', 'nope')).toBeNull();
  });

  it('SET NX succeeds only when the key is absent', () => {
    const { run } = makeHarness();
    expect(run('SET', 'k', 'v1', 'NX')).toBe('OK');
    expect(run('SET', 'k', 'v2', 'NX')).toBeNull();
    expect(run('GET', 'k')).toBe('v1');
  });

  it('SET XX succeeds only when the key exists', () => {
    const { run } = makeHarness();
    expect(run('SET', 'k', 'v1', 'XX')).toBeNull();
    expect(run('GET', 'k')).toBeNull();
    run('SET', 'k', 'v1');
    expect(run('SET', 'k', 'v2', 'XX')).toBe('OK');
    expect(run('GET', 'k')).toBe('v2');
  });

  it('SET NX treats an expired key as absent', () => {
    const { run, clock } = makeHarness();
    run('SET', 'k', 'old', 'PX', '100');
    clock.now += 200;
    expect(run('SET', 'k', 'new', 'NX')).toBe('OK');
    expect(run('GET', 'k')).toBe('new');
  });

  it('SET EX sets a TTL in seconds', () => {
    const { run } = makeHarness();
    expect(run('SET', 'k', 'v', 'EX', '10')).toBe('OK');
    expect(run('TTL', 'k')).toBe(10);
    expect(run('PTTL', 'k')).toBe(10_000);
  });

  it('SET PX sets a TTL in milliseconds', () => {
    const { run } = makeHarness();
    expect(run('SET', 'k', 'v', 'PX', '5500')).toBe('OK');
    expect(run('PTTL', 'k')).toBe(5500);
    expect(run('TTL', 'k')).toBe(6); // rounded to the nearest second
  });

  it('SET EX NX combine', () => {
    const { run } = makeHarness();
    expect(run('SET', 'k', 'v', 'EX', '10', 'NX')).toBe('OK');
    expect(run('SET', 'k', 'v2', 'EX', '99', 'NX')).toBeNull();
    expect(run('TTL', 'k')).toBe(10); // failed NX must not touch the TTL
  });

  it('a plain SET clears any existing TTL', () => {
    const { run } = makeHarness();
    run('SET', 'k', 'v', 'EX', '10');
    run('SET', 'k', 'v2');
    expect(run('TTL', 'k')).toBe(-1);
  });

  it.each([
    [['SET', 'k', 'v', 'NX', 'XX'], 'ERR syntax error'],
    [['SET', 'k', 'v', 'BOGUS'], 'ERR syntax error'],
    [['SET', 'k', 'v', 'EX'], 'ERR syntax error'],
    [['SET', 'k', 'v', 'EX', '10', 'PX', '100'], 'ERR syntax error'],
    [['SET', 'k', 'v', 'EX', 'abc'], 'ERR value is not an integer or out of range'],
    [['SET', 'k', 'v', 'EX', '0'], "ERR invalid expire time in 'set' command"],
    [['SET', 'k', 'v', 'PX', '-5'], "ERR invalid expire time in 'set' command"],
  ])('rejects %j with %s', (args, message) => {
    const { run } = makeHarness();
    expect(errorOf(run(...(args as string[])))).toBe(message);
  });

  it('values are binary safe', () => {
    const { run } = makeHarness();
    const value = Buffer.from([0x00, 0x0d, 0x0a, 0xc3, 0xa9]);
    expect(run('SET', 'bin', value)).toBe('OK');
    expect(run('STRLEN', 'bin')).toBe(5);
  });
});

describe('DEL and EXISTS', () => {
  it('DEL removes keys and counts only the ones that existed', () => {
    const { run } = makeHarness();
    run('SET', 'a', '1');
    run('SET', 'b', '2');
    expect(run('DEL', 'a', 'b', 'missing')).toBe(2);
    expect(run('GET', 'a')).toBeNull();
    expect(run('DEL', 'a')).toBe(0);
  });

  it('EXISTS counts keys, including repeats', () => {
    const { run } = makeHarness();
    run('SET', 'a', '1');
    expect(run('EXISTS', 'a')).toBe(1);
    expect(run('EXISTS', 'a', 'a', 'missing')).toBe(2);
    expect(run('EXISTS', 'missing')).toBe(0);
  });
});

describe('INCR family', () => {
  it('INCR initializes a missing key to 0 first', () => {
    const { run } = makeHarness();
    expect(run('INCR', 'n')).toBe(1);
    expect(run('INCR', 'n')).toBe(2);
    expect(run('GET', 'n')).toBe('2');
  });

  it('DECR decrements below zero', () => {
    const { run } = makeHarness();
    expect(run('DECR', 'n')).toBe(-1);
    expect(run('DECR', 'n')).toBe(-2);
  });

  it('INCRBY and DECRBY accept signed deltas', () => {
    const { run } = makeHarness();
    expect(run('INCRBY', 'n', '15')).toBe(15);
    expect(run('INCRBY', 'n', '-20')).toBe(-5);
    expect(run('DECRBY', 'n', '-10')).toBe(5);
  });

  it('rejects non-integer stored values', () => {
    const { run } = makeHarness();
    run('SET', 'k', 'not a number');
    expect(errorOf(run('INCR', 'k'))).toBe('ERR value is not an integer or out of range');
  });

  it('rejects a non-integer delta', () => {
    const { run } = makeHarness();
    expect(errorOf(run('INCRBY', 'k', 'ten'))).toBe('ERR value is not an integer or out of range');
  });

  it('handles the full signed 64-bit range', () => {
    const { run } = makeHarness();
    run('SET', 'n', '9223372036854775806');
    expect(run('INCR', 'n')).toBe(9223372036854775807);
    expect(errorOf(run('INCR', 'n'))).toBe('ERR increment or decrement would overflow');
    expect(run('GET', 'n')).toBe('9223372036854775807');

    run('SET', 'm', '-9223372036854775808');
    expect(errorOf(run('DECR', 'm'))).toBe('ERR increment or decrement would overflow');
  });

  it('INCR preserves an existing TTL', () => {
    const { run } = makeHarness();
    run('SET', 'n', '5', 'EX', '100');
    run('INCR', 'n');
    expect(run('TTL', 'n')).toBe(100);
    expect(run('GET', 'n')).toBe('6');
  });
});

describe('APPEND, STRLEN, TYPE', () => {
  it('APPEND creates a key, then extends it', () => {
    const { run } = makeHarness();
    expect(run('APPEND', 'k', 'Hello')).toBe(5);
    expect(run('APPEND', 'k', ' World')).toBe(11);
    expect(run('GET', 'k')).toBe('Hello World');
  });

  it('APPEND preserves an existing TTL', () => {
    const { run } = makeHarness();
    run('SET', 'k', 'a', 'EX', '50');
    run('APPEND', 'k', 'b');
    expect(run('TTL', 'k')).toBe(50);
  });

  it('STRLEN reports byte length, and 0 for missing keys', () => {
    const { run } = makeHarness();
    run('SET', 'k', 'hello');
    expect(run('STRLEN', 'k')).toBe(5);
    expect(run('STRLEN', 'missing')).toBe(0);
  });

  it('TYPE distinguishes string and none', () => {
    const { run } = makeHarness();
    run('SET', 'k', 'v');
    expect(run('TYPE', 'k')).toBe('string');
    expect(run('TYPE', 'missing')).toBe('none');
  });
});

describe('MGET', () => {
  it('returns values in order with nulls for missing keys', () => {
    const { run } = makeHarness();
    run('SET', 'a', '1');
    run('SET', 'c', '3');
    expect(run('MGET', 'a', 'b', 'c')).toEqual(['1', null, '3']);
  });

  it('returns a single-element array for one key', () => {
    const { run } = makeHarness();
    run('SET', 'a', 'hello');
    expect(run('MGET', 'a')).toEqual(['hello']);
    expect(run('MGET', 'missing')).toEqual([null]);
  });

  it('treats an expired key as missing', () => {
    const { run, clock } = makeHarness();
    run('SET', 'a', '1', 'PX', '100');
    run('SET', 'b', '2');
    clock.now += 200;
    expect(run('MGET', 'a', 'b')).toEqual([null, '2']);
  });

  it('counts keyspace hits and misses per key', () => {
    const { run } = makeHarness();
    run('SET', 'a', '1');
    run('MGET', 'a', 'missing', 'a');
    const info = run('INFO', 'stats') as string;
    expect(info).toContain('keyspace_hits:2');
    expect(info).toContain('keyspace_misses:1');
  });
});

describe('MSET and MSETNX', () => {
  it('MSET sets every pair and returns OK', () => {
    const { run } = makeHarness();
    expect(run('MSET', 'a', '1', 'b', '2', 'c', '3')).toBe('OK');
    expect(run('MGET', 'a', 'b', 'c')).toEqual(['1', '2', '3']);
  });

  it('MSET overwrites and clears any existing TTL', () => {
    const { run } = makeHarness();
    run('SET', 'a', 'old', 'EX', '100');
    expect(run('MSET', 'a', 'new')).toBe('OK');
    expect(run('GET', 'a')).toBe('new');
    expect(run('TTL', 'a')).toBe(-1);
  });

  it('MSET rejects an odd number of arguments', () => {
    const { run } = makeHarness();
    expect(errorOf(run('MSET', 'a', '1', 'b'))).toBe(
      "ERR wrong number of arguments for 'mset' command",
    );
    // A single argument is caught by the dispatch arity check.
    expect(errorOf(run('MSET', 'a'))).toBe("ERR wrong number of arguments for 'mset' command");
  });

  it('MSETNX sets all and returns 1 only when no key exists', () => {
    const { run } = makeHarness();
    expect(run('MSETNX', 'a', '1', 'b', '2')).toBe(1);
    expect(run('MGET', 'a', 'b')).toEqual(['1', '2']);
  });

  it('MSETNX sets nothing and returns 0 if any key already exists', () => {
    const { run } = makeHarness();
    run('SET', 'b', 'existing');
    expect(run('MSETNX', 'a', '1', 'b', '2', 'c', '3')).toBe(0);
    expect(run('GET', 'a')).toBeNull();
    expect(run('GET', 'b')).toBe('existing');
    expect(run('GET', 'c')).toBeNull();
  });

  it('MSETNX treats an expired key as absent', () => {
    const { run, clock } = makeHarness();
    run('SET', 'a', 'old', 'PX', '100');
    clock.now += 200;
    expect(run('MSETNX', 'a', 'new', 'b', '2')).toBe(1);
    expect(run('MGET', 'a', 'b')).toEqual(['new', '2']);
  });

  it('MSETNX with a repeated key sets the last value', () => {
    const { run } = makeHarness();
    expect(run('MSETNX', 'k', '1', 'k', '2')).toBe(1);
    expect(run('GET', 'k')).toBe('2');
  });

  it('MSETNX rejects an odd number of arguments', () => {
    const { run } = makeHarness();
    expect(errorOf(run('MSETNX', 'a', '1', 'b'))).toBe(
      "ERR wrong number of arguments for 'msetnx' command",
    );
  });
});

describe('GETDEL', () => {
  it('returns the value and removes the key', () => {
    const { run } = makeHarness();
    run('SET', 'k', 'v');
    expect(run('GETDEL', 'k')).toBe('v');
    expect(run('GET', 'k')).toBeNull();
    expect(run('EXISTS', 'k')).toBe(0);
  });

  it('returns null for a missing key and does nothing', () => {
    const { run } = makeHarness();
    expect(run('GETDEL', 'missing')).toBeNull();
  });

  it('treats an expired key as missing', () => {
    const { run, clock } = makeHarness();
    run('SET', 'k', 'v', 'PX', '100');
    clock.now += 200;
    expect(run('GETDEL', 'k')).toBeNull();
  });
});

describe('GETRANGE', () => {
  it('returns an inclusive substring', () => {
    const { run } = makeHarness();
    run('SET', 'k', 'This is a string');
    expect(run('GETRANGE', 'k', '0', '3')).toBe('This');
    expect(run('GETRANGE', 'k', '0', '-1')).toBe('This is a string');
  });

  it('supports negative indices counting from the end', () => {
    const { run } = makeHarness();
    run('SET', 'k', 'This is a string');
    expect(run('GETRANGE', 'k', '-3', '-1')).toBe('ing');
    expect(run('GETRANGE', 'k', '-6', '-1')).toBe('string');
  });

  it('clamps out-of-range bounds', () => {
    const { run } = makeHarness();
    run('SET', 'k', 'This is a string');
    expect(run('GETRANGE', 'k', '10', '100')).toBe('string');
    expect(run('GETRANGE', 'k', '-100', '3')).toBe('This');
  });

  it('returns an empty string when start is past end or the key is missing', () => {
    const { run } = makeHarness();
    run('SET', 'k', 'hello');
    expect(run('GETRANGE', 'k', '4', '2')).toBe('');
    expect(run('GETRANGE', 'k', '100', '200')).toBe('');
    expect(run('GETRANGE', 'missing', '0', '-1')).toBe('');
  });

  it('is binary safe', () => {
    const { run } = makeHarness();
    run('SET', 'k', Buffer.from([0x00, 0x61, 0x00, 0x62]));
    expect(run('GETRANGE', 'k', '1', '1')).toBe('a');
    expect(run('GETRANGE', 'k', '0', '0')).toBe('\u0000');
  });

  it('rejects non-integer bounds', () => {
    const { run } = makeHarness();
    run('SET', 'k', 'hello');
    expect(errorOf(run('GETRANGE', 'k', 'x', '2'))).toBe(
      'ERR value is not an integer or out of range',
    );
    expect(errorOf(run('GETRANGE', 'k', '0', 'y'))).toBe(
      'ERR value is not an integer or out of range',
    );
  });
});

describe('SETRANGE', () => {
  it('overwrites a slice of an existing value', () => {
    const { run } = makeHarness();
    run('SET', 'k', 'Hello World');
    expect(run('SETRANGE', 'k', '6', 'Redis')).toBe(11);
    expect(run('GET', 'k')).toBe('Hello Redis');
  });

  it('extends the value with null-byte padding when the offset is past the end', () => {
    const { run } = makeHarness();
    expect(run('SETRANGE', 'k', '5', 'Hello')).toBe(10);
    expect(run('STRLEN', 'k')).toBe(10);
    expect(run('GET', 'k')).toBe(`${'\u0000'.repeat(5)}Hello`);
  });

  it('grows an existing value and zero-fills the gap', () => {
    const { run } = makeHarness();
    run('SET', 'k', 'ab');
    expect(run('SETRANGE', 'k', '4', 'z')).toBe(5);
    expect(run('GET', 'k')).toBe(`ab${'\u0000'.repeat(2)}z`);
  });

  it('treats an empty patch as a no-op without creating the key', () => {
    const { run } = makeHarness();
    expect(run('SETRANGE', 'missing', '0', '')).toBe(0);
    expect(run('EXISTS', 'missing')).toBe(0);
    run('SET', 'k', 'hello');
    expect(run('SETRANGE', 'k', '0', '')).toBe(5);
    expect(run('GET', 'k')).toBe('hello');
  });

  it('preserves an existing TTL', () => {
    const { run } = makeHarness();
    run('SET', 'k', 'Hello World', 'EX', '100');
    run('SETRANGE', 'k', '6', 'Redis');
    expect(run('TTL', 'k')).toBe(100);
  });

  it('rejects a negative offset', () => {
    const { run } = makeHarness();
    expect(errorOf(run('SETRANGE', 'k', '-1', 'v'))).toBe('ERR offset is out of range');
  });

  it('rejects a non-integer offset', () => {
    const { run } = makeHarness();
    expect(errorOf(run('SETRANGE', 'k', 'x', 'v'))).toBe(
      'ERR value is not an integer or out of range',
    );
  });
});

describe('INCRBYFLOAT', () => {
  it('initializes a missing key from zero', () => {
    const { run } = makeHarness();
    expect(run('INCRBYFLOAT', 'k', '10.5')).toBe('10.5');
    expect(run('GET', 'k')).toBe('10.5');
  });

  it('adds to an existing value and trims trailing zeros', () => {
    const { run } = makeHarness();
    run('SET', 'k', '10.50');
    expect(run('INCRBYFLOAT', 'k', '0.1')).toBe('10.6');
    expect(run('INCRBYFLOAT', 'k', '-5')).toBe('5.6');
  });

  it('accepts scientific notation and returns an integer without a point', () => {
    const { run } = makeHarness();
    run('SET', 'k', '5.0e3');
    expect(run('INCRBYFLOAT', 'k', '2.0e2')).toBe('5200');
  });

  it('rejects a non-float stored value', () => {
    const { run } = makeHarness();
    run('SET', 'k', 'not a number');
    expect(errorOf(run('INCRBYFLOAT', 'k', '1.0'))).toBe('ERR value is not a valid float');
  });

  it('rejects a non-float increment', () => {
    const { run } = makeHarness();
    expect(errorOf(run('INCRBYFLOAT', 'k', 'abc'))).toBe('ERR value is not a valid float');
    expect(errorOf(run('INCRBYFLOAT', 'k', '3.0e3.0'))).toBe('ERR value is not a valid float');
  });

  it('rejects an increment that overflows to infinity', () => {
    const { run } = makeHarness();
    run('SET', 'k', '1e308');
    expect(errorOf(run('INCRBYFLOAT', 'k', '1e308'))).toBe(
      'ERR increment would produce NaN or Infinity',
    );
  });

  it('preserves an existing TTL', () => {
    const { run } = makeHarness();
    run('SET', 'k', '5', 'EX', '100');
    expect(run('INCRBYFLOAT', 'k', '2.5')).toBe('7.5');
    expect(run('TTL', 'k')).toBe(100);
  });
});

describe('KEYS and SCAN', () => {
  it('KEYS filters by glob pattern', () => {
    const { run } = makeHarness();
    run('SET', 'user:1', 'a');
    run('SET', 'user:2', 'b');
    run('SET', 'session:1', 'c');
    expect((run('KEYS', 'user:*') as string[]).sort()).toEqual(['user:1', 'user:2']);
    expect(run('KEYS', 'nomatch*')).toEqual([]);
    expect((run('KEYS', '*') as string[]).length).toBe(3);
  });

  it('KEYS does not return expired keys', () => {
    const { run, clock } = makeHarness();
    run('SET', 'a', '1', 'PX', '100');
    run('SET', 'b', '2');
    clock.now += 200;
    expect(run('KEYS', '*')).toEqual(['b']);
  });

  it('SCAN iterates the whole keyspace across cursors', () => {
    const { run } = makeHarness();
    for (let i = 0; i < 25; i++) run('SET', `key:${i}`, 'v');

    const seen = new Set<string>();
    let cursor = '0';
    let rounds = 0;
    do {
      const reply = run('SCAN', cursor, 'COUNT', '7') as [string, string[]];
      cursor = reply[0];
      for (const key of reply[1]) seen.add(key);
      rounds += 1;
      expect(rounds).toBeLessThan(50);
    } while (cursor !== '0');

    expect(seen.size).toBe(25);
  });

  it('SCAN MATCH filters within the window', () => {
    const { run } = makeHarness();
    run('SET', 'a:1', 'v');
    run('SET', 'a:2', 'v');
    run('SET', 'b:1', 'v');
    const reply = run('SCAN', '0', 'MATCH', 'a:*', 'COUNT', '100') as [string, string[]];
    expect(reply[0]).toBe('0');
    expect(reply[1].sort()).toEqual(['a:1', 'a:2']);
  });

  it('SCAN rejects bad cursors and options', () => {
    const { run } = makeHarness();
    expect(errorOf(run('SCAN', 'abc'))).toBe('ERR invalid cursor');
    expect(errorOf(run('SCAN', '0', 'COUNT', '0'))).toBe('ERR syntax error');
    expect(errorOf(run('SCAN', '0', 'BOGUS', 'x'))).toBe('ERR syntax error');
    expect(errorOf(run('SCAN', '0', 'MATCH'))).toBe('ERR syntax error');
  });
});

describe('FLUSHALL and DBSIZE', () => {
  it('FLUSHALL empties the keyspace', () => {
    const { run } = makeHarness();
    run('SET', 'a', '1');
    run('SET', 'b', '2');
    expect(run('DBSIZE')).toBe(2);
    expect(run('FLUSHALL')).toBe('OK');
    expect(run('DBSIZE')).toBe(0);
    expect(run('GET', 'a')).toBeNull();
  });

  it('FLUSHALL accepts ASYNC and SYNC and rejects anything else', () => {
    const { run } = makeHarness();
    expect(run('FLUSHALL', 'ASYNC')).toBe('OK');
    expect(run('FLUSHALL', 'sync')).toBe('OK');
    expect(errorOf(run('FLUSHALL', 'NOW'))).toBe('ERR syntax error');
  });

  it('DBSIZE excludes expired keys', () => {
    const { run, clock } = makeHarness();
    run('SET', 'a', '1', 'PX', '50');
    run('SET', 'b', '2');
    expect(run('DBSIZE')).toBe(2);
    clock.now += 100;
    expect(run('DBSIZE')).toBe(1);
  });
});

describe('INFO and COMMAND', () => {
  it('INFO includes the expected sections and fields', () => {
    const { run } = makeHarness();
    run('SET', 'k', 'v', 'EX', '100');
    const info = run('INFO') as string;
    expect(info).toContain('# Server');
    expect(info).toContain('respite_version:0.1.0');
    expect(info).toContain('# Memory');
    expect(info).toContain('maxmemory_policy:noeviction');
    expect(info).toContain('# Stats');
    expect(info).toContain('total_commands_processed:');
    expect(info).toContain('db0:keys=1,expires=1');
  });

  it('INFO <section> filters output', () => {
    const { run } = makeHarness();
    const info = run('INFO', 'server') as string;
    expect(info).toContain('# Server');
    expect(info).not.toContain('# Memory');
  });

  it('INFO reports the allkeys-lru policy when maxmemory is set', () => {
    const { run } = makeHarness({ maxmemory: 1024 });
    expect(run('INFO', 'memory')).toContain('maxmemory_policy:allkeys-lru');
  });

  it('tracks keyspace hits and misses', () => {
    const { run } = makeHarness();
    run('SET', 'k', 'v');
    run('GET', 'k');
    run('GET', 'k');
    run('GET', 'missing');
    const info = run('INFO', 'stats') as string;
    expect(info).toContain('keyspace_hits:2');
    expect(info).toContain('keyspace_misses:1');
  });

  it('COMMAND returns an empty array so clients can connect', () => {
    const { run } = makeHarness();
    expect(run('COMMAND')).toEqual([]);
    expect(run('COMMAND', 'DOCS')).toEqual([]);
  });
});

describe('dispatch', () => {
  it('rejects unknown commands', () => {
    const { run } = makeHarness();
    expect(errorOf(run('LPUSH', 'k', 'v'))).toBe("ERR unknown command 'LPUSH'");
  });

  it('rejects wrong arity with the redis-style message', () => {
    const { run } = makeHarness();
    expect(errorOf(run('GET'))).toBe("ERR wrong number of arguments for 'get' command");
    expect(errorOf(run('GET', 'a', 'b'))).toBe("ERR wrong number of arguments for 'get' command");
    expect(errorOf(run('SET', 'k'))).toBe("ERR wrong number of arguments for 'set' command");
    expect(errorOf(run('ECHO'))).toBe("ERR wrong number of arguments for 'echo' command");
  });

  it('QUIT replies OK and asks for the connection to close', () => {
    const { engine } = makeHarness();
    const result = engine.execute([Buffer.from('QUIT')]);
    expect(result.reply.toString('latin1')).toBe('+OK\r\n');
    expect(result.close).toBe(true);
  });

  it('BGREWRITEAOF errors when persistence is disabled', () => {
    const { run } = makeHarness();
    expect(errorOf(run('BGREWRITEAOF'))).toContain('append only mode is disabled');
  });
});
