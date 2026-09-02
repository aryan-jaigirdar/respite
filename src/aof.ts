/**
 * Append-only file persistence.
 *
 * The AOF format is exactly the wire format: a sequence of RESP arrays of
 * bulk strings, one per mutating command. That means loading is just feeding
 * the file through the same streaming parser the server uses for sockets, and
 * the format is binary safe for free.
 *
 * Time-relative commands are never written. The command layer normalizes
 * every expiry into an absolute PEXPIREAT before propagation, so replaying a
 * file hours later yields the same deadlines.
 *
 * Durability model (documented in the README): appends go through the OS page
 * cache (`fs.writeSync` on an O_APPEND fd) and are fsynced on rewrite and on
 * graceful shutdown. There is no per-command or per-second fsync.
 */

import fs from 'node:fs';
import { encodeCommand } from './resp/writer.js';
import { RespCommandParser, RespProtocolError } from './resp/parser.js';
import type { StoreEntrySnapshot } from './store.js';

export class AofLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AofLoadError';
  }
}

export interface AofLoadResult {
  /** Commands successfully replayed. */
  commands: number;
  /** Byte length of the valid prefix of the file. */
  validBytes: number;
  /** Trailing bytes that did not form a complete command (torn last write). */
  truncatedBytes: number;
}

/**
 * Replays an append-only file through `apply`. A missing file is an empty
 * dataset, not an error. A torn final command (e.g. the process died mid
 * write) is tolerated and reported via `truncatedBytes`; corruption anywhere
 * else throws {@link AofLoadError}.
 */
export function loadAof(filePath: string, apply: (args: Buffer[]) => void): AofLoadResult {
  let data: Buffer;
  try {
    data = fs.readFileSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { commands: 0, validBytes: 0, truncatedBytes: 0 };
    }
    throw error;
  }

  const parser = new RespCommandParser();
  let commands: Buffer[][];
  try {
    commands = parser.feed(data);
  } catch (error) {
    if (error instanceof RespProtocolError) {
      throw new AofLoadError(`bad file format in ${filePath}: ${error.message}`);
    }
    throw error;
  }

  for (const command of commands) apply(command);

  const truncatedBytes = parser.bufferedBytes;
  return { commands: commands.length, validBytes: data.length - truncatedBytes, truncatedBytes };
}

export class AppendOnlyFile {
  private fd: number;

  constructor(readonly path: string) {
    this.fd = fs.openSync(path, 'a');
  }

  append(args: readonly (string | Buffer)[]): void {
    const encoded = encodeCommand(args);
    fs.writeSync(this.fd, encoded, 0, encoded.length);
  }

  fsync(): void {
    fs.fsyncSync(this.fd);
  }

  /**
   * Compacts the file to the minimal command sequence reproducing the current
   * dataset: one SET per live key, plus a PEXPIREAT when the key has an
   * expiry. The rewrite is synchronous (the "BG" in BGREWRITEAOF is kept only
   * for wire compatibility): write to a temp file, fsync, then atomically
   * rename over the old file so a crash can never leave a half-written AOF in
   * place.
   */
  rewrite(entries: Iterable<StoreEntrySnapshot>): void {
    const tmpPath = `${this.path}.rewrite-${process.pid}.tmp`;
    const tmpFd = fs.openSync(tmpPath, 'w');
    try {
      for (const entry of entries) {
        const setCmd = encodeCommand(['SET', entry.key, entry.value]);
        fs.writeSync(tmpFd, setCmd, 0, setCmd.length);
        if (entry.expireAt !== null) {
          const expireCmd = encodeCommand(['PEXPIREAT', entry.key, String(entry.expireAt)]);
          fs.writeSync(tmpFd, expireCmd, 0, expireCmd.length);
        }
      }
      fs.fsyncSync(tmpFd);
      fs.closeSync(tmpFd);
    } catch (error) {
      try {
        fs.closeSync(tmpFd);
      } catch {
        // already closed
      }
      fs.rmSync(tmpPath, { force: true });
      throw error;
    }

    fs.closeSync(this.fd);
    fs.renameSync(tmpPath, this.path);
    this.fd = fs.openSync(this.path, 'a');
  }

  close(): void {
    try {
      fs.fsyncSync(this.fd);
    } finally {
      fs.closeSync(this.fd);
    }
  }
}
