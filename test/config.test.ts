import { describe, expect, it } from 'vitest';
import { CliError, parseCliArgs, parseMemorySize } from '../src/config.js';
import { DEFAULT_HOST, DEFAULT_PORT } from '../src/server.js';

describe('parseMemorySize', () => {
  it.each([
    ['0', 0],
    ['1048576', 1048576],
    ['512b', 512],
    ['1kb', 1024],
    ['64mb', 64 * 1024 * 1024],
    ['1gb', 1024 * 1024 * 1024],
    ['64MB', 64 * 1024 * 1024],
    [' 64mb ', 64 * 1024 * 1024],
  ])('parses %j as %d bytes', (input, expected) => {
    expect(parseMemorySize(input)).toBe(expected);
  });

  it.each(['', 'abc', '64tb', 'mb', '-1', '1.5mb', '64 m b'])('rejects %j', (input) => {
    expect(() => parseMemorySize(input)).toThrow(CliError);
  });
});

describe('parseCliArgs', () => {
  it('applies defaults when no flags are given', () => {
    expect(parseCliArgs([])).toEqual({
      port: DEFAULT_PORT,
      host: DEFAULT_HOST,
      maxmemory: 0,
      appendonly: null,
      help: false,
      version: false,
    });
  });

  it('parses the documented invocation', () => {
    const options = parseCliArgs(['--port', '6380', '--maxmemory', '64mb', '--appendonly', 'data.aof']);
    expect(options.port).toBe(6380);
    expect(options.maxmemory).toBe(64 * 1024 * 1024);
    expect(options.appendonly).toBe('data.aof');
  });

  it('accepts --flag=value syntax', () => {
    const options = parseCliArgs(['--port=7000', '--maxmemory=1kb', '--host=0.0.0.0']);
    expect(options.port).toBe(7000);
    expect(options.maxmemory).toBe(1024);
    expect(options.host).toBe('0.0.0.0');
  });

  it('parses help and version shorthands', () => {
    expect(parseCliArgs(['-h']).help).toBe(true);
    expect(parseCliArgs(['--help']).help).toBe(true);
    expect(parseCliArgs(['-v']).version).toBe(true);
    expect(parseCliArgs(['--version']).version).toBe(true);
  });

  it.each([
    [['--port', 'abc'], /invalid port/],
    [['--port', '70000'], /invalid port/],
    [['--port', '-1'], /invalid port|unknown option/],
    [['--port'], /requires a value/],
    [['--maxmemory', 'lots'], /invalid memory size/],
    [['--appendonly'], /requires a value/],
    [['--bogus'], /unknown option/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseCliArgs(argv as string[])).toThrow(message);
  });
});
