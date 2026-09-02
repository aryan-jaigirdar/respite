import { describe, expect, it } from 'vitest';
import { RespCommandParser, RespProtocolError } from '../src/resp/parser.js';
import { encodeCommand } from '../src/resp/writer.js';

function feedString(parser: RespCommandParser, data: string): Buffer[][] {
  return parser.feed(Buffer.from(data, 'latin1'));
}

function toStrings(command: Buffer[]): string[] {
  return command.map((arg) => arg.toString('latin1'));
}

describe('RespCommandParser', () => {
  it('parses a single complete command', () => {
    const parser = new RespCommandParser();
    const commands = feedString(parser, '*3\r\n$3\r\nSET\r\n$3\r\nfoo\r\n$3\r\nbar\r\n');
    expect(commands).toHaveLength(1);
    expect(toStrings(commands[0]!)).toEqual(['SET', 'foo', 'bar']);
    expect(parser.bufferedBytes).toBe(0);
  });

  it('parses a command delivered one byte at a time', () => {
    const parser = new RespCommandParser();
    const wire = Buffer.from('*2\r\n$4\r\nECHO\r\n$5\r\nhello\r\n', 'latin1');
    const collected: Buffer[][] = [];
    for (const byte of wire) {
      collected.push(...parser.feed(Buffer.from([byte])));
    }
    expect(collected).toHaveLength(1);
    expect(toStrings(collected[0]!)).toEqual(['ECHO', 'hello']);
  });

  it('parses correctly across every possible split point', () => {
    const wire = Buffer.from('*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$7\r\nv\r\nwith\r\n', 'latin1');
    for (let split = 1; split < wire.length; split++) {
      const parser = new RespCommandParser();
      const first = parser.feed(wire.subarray(0, split));
      const second = parser.feed(wire.subarray(split));
      const commands = [...first, ...second];
      expect(commands, `split at byte ${split}`).toHaveLength(1);
      expect(toStrings(commands[0]!)).toEqual(['SET', 'k', 'v\r\nwith']);
    }
  });

  it('returns multiple commands arriving in one chunk', () => {
    const parser = new RespCommandParser();
    const chunk = Buffer.concat([encodeCommand(['PING']), encodeCommand(['GET', 'x'])]);
    const commands = parser.feed(chunk);
    expect(commands.map(toStrings)).toEqual([['PING'], ['GET', 'x']]);
  });

  it('keeps a trailing partial command buffered until it completes', () => {
    const parser = new RespCommandParser();
    const first = feedString(parser, '*1\r\n$4\r\nPING\r\n*2\r\n$3\r\nGET\r\n$1');
    expect(first.map(toStrings)).toEqual([['PING']]);
    expect(parser.bufferedBytes).toBeGreaterThan(0);
    const second = feedString(parser, '\r\nx\r\n');
    expect(second.map(toStrings)).toEqual([['GET', 'x']]);
    expect(parser.bufferedBytes).toBe(0);
  });

  it('is binary safe: bulk payloads may contain CR, LF, and NUL bytes', () => {
    const parser = new RespCommandParser();
    const payload = Buffer.from([0x00, 0x0d, 0x0a, 0xff, 0x0d, 0x0a]);
    const wire = Buffer.concat([encodeCommand(['SET', 'bin', payload])]);
    const commands = parser.feed(wire);
    expect(commands).toHaveLength(1);
    expect(commands[0]![2]!.equals(payload)).toBe(true);
  });

  it('parses empty bulk strings', () => {
    const parser = new RespCommandParser();
    const commands = feedString(parser, '*2\r\n$3\r\nGET\r\n$0\r\n\r\n');
    expect(toStrings(commands[0]!)).toEqual(['GET', '']);
  });

  it('argument buffers remain valid after further feeds', () => {
    const parser = new RespCommandParser();
    const [first] = feedString(parser, '*2\r\n$3\r\nGET\r\n$3\r\nabc\r\n');
    feedString(parser, '*2\r\n$3\r\nGET\r\n$3\r\nxyz\r\n');
    expect(toStrings(first!)).toEqual(['GET', 'abc']);
  });

  it('skips empty *0 arrays', () => {
    const parser = new RespCommandParser();
    const commands = feedString(parser, '*0\r\n*1\r\n$4\r\nPING\r\n');
    expect(commands.map(toStrings)).toEqual([['PING']]);
  });

  describe('inline commands', () => {
    it('parses a bare inline command', () => {
      const parser = new RespCommandParser();
      expect(feedString(parser, 'PING\r\n').map(toStrings)).toEqual([['PING']]);
    });

    it('splits inline arguments on whitespace', () => {
      const parser = new RespCommandParser();
      expect(feedString(parser, 'SET  foo   bar\r\n').map(toStrings)).toEqual([
        ['SET', 'foo', 'bar'],
      ]);
    });

    it('accepts LF-only line endings', () => {
      const parser = new RespCommandParser();
      expect(feedString(parser, 'PING\n').map(toStrings)).toEqual([['PING']]);
    });

    it('ignores blank lines', () => {
      const parser = new RespCommandParser();
      expect(feedString(parser, '\r\n  \r\nPING\r\n').map(toStrings)).toEqual([['PING']]);
    });

    it('buffers an inline command until its newline arrives', () => {
      const parser = new RespCommandParser();
      expect(feedString(parser, 'PIN')).toEqual([]);
      expect(feedString(parser, 'G\r\n').map(toStrings)).toEqual([['PING']]);
    });
  });

  describe('protocol errors', () => {
    it.each([
      ['non-numeric multibulk length', '*abc\r\n', /invalid multibulk length/],
      ['negative multibulk length', '*-1\r\n', /invalid multibulk length/],
      ['oversized multibulk length', '*99999999\r\n', /invalid multibulk length/],
      ['array element without $', '*1\r\n+PING\r\n', /expected '\$', got '\+'/],
      ['negative bulk length inside a command', '*1\r\n$-1\r\n', /invalid bulk length/],
      ['non-numeric bulk length', '*1\r\n$abc\r\n', /invalid bulk length/],
      ['oversized bulk length', '*1\r\n$999999999999\r\n', /invalid bulk length/],
      ['missing CRLF after bulk payload', '*1\r\n$3\r\nfooxx', /expected CRLF after bulk payload/],
    ])('rejects %s', (_name, wire, message) => {
      const parser = new RespCommandParser();
      expect(() => feedString(parser, wire)).toThrow(RespProtocolError);
      const fresh = new RespCommandParser();
      expect(() => feedString(fresh, wire)).toThrow(message);
    });

    it('rejects an unterminated header that grows without bound', () => {
      const parser = new RespCommandParser();
      expect(() => feedString(parser, `*${'9'.repeat(64)}`)).toThrow(RespProtocolError);
    });

    it('rejects an unterminated inline line that grows without bound', () => {
      const parser = new RespCommandParser();
      expect(() => feedString(parser, 'a'.repeat(70 * 1024))).toThrow(/too big inline request/);
    });
  });

  it('round-trips commands produced by the writer', () => {
    const parser = new RespCommandParser();
    const args = ['SET', 'key with spaces', 'value\r\nwith newlines'];
    const commands = parser.feed(encodeCommand(args));
    expect(toStrings(commands[0]!)).toEqual(args);
  });
});
