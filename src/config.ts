/**
 * Hand-rolled CLI argument parsing. Zero dependencies is a design constraint
 * of this project, so no commander/yargs.
 */

import { DEFAULT_HOST, DEFAULT_PORT } from './server.js';

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

export interface CliOptions {
  port: number;
  host: string;
  /** Bytes; 0 means unlimited. */
  maxmemory: number;
  /** AOF path, or null when persistence is disabled. */
  appendonly: string | null;
  help: boolean;
  version: boolean;
}

export const USAGE = `Usage: respite [options]

An in-memory key-value store speaking the Redis wire protocol (RESP2).

Options:
  --port <port>        TCP port to listen on (default: ${DEFAULT_PORT})
  --host <host>        Address to bind (default: ${DEFAULT_HOST})
  --maxmemory <size>   Memory ceiling with LRU eviction, e.g. 64mb, 1gb,
                       1048576 (bytes). Default: unlimited.
  --appendonly <path>  Enable append-only persistence to the given file.
  -h, --help           Show this help.
  -v, --version        Show the version.

Examples:
  respite --port 6380 --maxmemory 64mb --appendonly data.aof
  redis-cli -p 6380 ping`;

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
};

/** Parses sizes like "64mb", "1gb", "1048576" (bytes). Units are 1024-based. */
export function parseMemorySize(input: string): number {
  const match = /^(\d+)\s*(b|kb|mb|gb)?$/i.exec(input.trim());
  if (match === null) {
    throw new CliError(`invalid memory size "${input}" (expected e.g. 1048576, 512kb, 64mb, 1gb)`);
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? 'b').toLowerCase();
  const bytes = amount * SIZE_UNITS[unit]!;
  if (!Number.isSafeInteger(bytes)) throw new CliError(`memory size "${input}" is too large`);
  return bytes;
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    maxmemory: 0,
    appendonly: null,
    help: false,
    version: false,
  };

  // Support both "--flag value" and "--flag=value".
  const tokens: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith('--') && arg.includes('=')) {
      const separator = arg.indexOf('=');
      tokens.push(arg.slice(0, separator), arg.slice(separator + 1));
    } else {
      tokens.push(arg);
    }
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const takeValue = (): string => {
      const value = tokens[i + 1];
      if (value === undefined) throw new CliError(`${token} requires a value`);
      i += 1;
      return value;
    };

    switch (token) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-v':
      case '--version':
        options.version = true;
        break;
      case '--port': {
        const raw = takeValue();
        const port = /^\d+$/.test(raw) ? Number(raw) : NaN;
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          throw new CliError(`invalid port "${raw}"`);
        }
        options.port = port;
        break;
      }
      case '--host':
        options.host = takeValue();
        break;
      case '--maxmemory':
        options.maxmemory = parseMemorySize(takeValue());
        break;
      case '--appendonly':
        options.appendonly = takeValue();
        break;
      default:
        throw new CliError(`unknown option "${token}"`);
    }
  }

  return options;
}
