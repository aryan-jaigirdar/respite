import { describe, expect, it } from 'vitest';
import * as resp from '../src/resp/writer.js';
import { decodeOne } from './helpers/resp.js';

describe('RESP writer', () => {
  it('encodes simple strings', () => {
    expect(resp.simpleString('OK').toString('latin1')).toBe('+OK\r\n');
  });

  it('encodes errors', () => {
    expect(resp.errorReply('ERR nope').toString('latin1')).toBe('-ERR nope\r\n');
  });

  it('sanitizes newlines out of line-based replies', () => {
    expect(resp.errorReply('ERR bad\r\nline').toString('latin1')).toBe('-ERR bad  line\r\n');
  });

  it('encodes integers from numbers and bigints', () => {
    expect(resp.integer(42).toString('latin1')).toBe(':42\r\n');
    expect(resp.integer(-1).toString('latin1')).toBe(':-1\r\n');
    expect(resp.integer(9223372036854775807n).toString('latin1')).toBe(':9223372036854775807\r\n');
  });

  it('rejects non-integer numbers', () => {
    expect(() => resp.integer(1.5)).toThrow(TypeError);
  });

  it('encodes bulk strings from strings and buffers', () => {
    expect(resp.bulk('hello').toString('latin1')).toBe('$5\r\nhello\r\n');
    expect(resp.bulk(Buffer.from([0x00, 0x0d, 0x0a])).toString('latin1')).toBe('$3\r\n\x00\r\n\r\n');
    expect(resp.bulk('').toString('latin1')).toBe('$0\r\n\r\n');
  });

  it('encodes the null bulk string and null array', () => {
    expect(resp.nullBulk.toString('latin1')).toBe('$-1\r\n');
    expect(resp.nullArray.toString('latin1')).toBe('*-1\r\n');
  });

  it('encodes arrays, including nested ones', () => {
    const encoded = resp.array([
      resp.bulk('a'),
      resp.integer(2),
      resp.array([resp.simpleString('x')]),
    ]);
    expect(decodeOne(encoded)).toEqual(['a', 2, ['x']]);
  });

  it('encodes empty arrays', () => {
    expect(resp.array([]).toString('latin1')).toBe('*0\r\n');
  });

  it('encodes commands as arrays of bulk strings', () => {
    expect(resp.encodeCommand(['GET', 'k']).toString('latin1')).toBe(
      '*2\r\n$3\r\nGET\r\n$1\r\nk\r\n',
    );
  });
});
