/**
 * Streaming RESP2 command parser.
 *
 * Clients send commands as RESP arrays of bulk strings, for example:
 *
 *   *3\r\n$3\r\nSET\r\n$3\r\nfoo\r\n$3\r\nbar\r\n
 *
 * TCP gives no framing guarantees: a single command may arrive split across
 * many `data` events, and one `data` event may carry many commands. The parser
 * therefore buffers input and only consumes bytes once a complete command is
 * available. `feed()` returns every command completed by the chunk it was
 * given, in order, and keeps any trailing partial command buffered for the
 * next call.
 *
 * As a fallback for telnet-style clients, a line that does not start with `*`
 * is treated as an inline command and split on whitespace.
 *
 * Protocol violations throw {@link RespProtocolError}. The caller is expected
 * to report the error to the client and close the connection, which is what
 * real Redis does; the parser makes no attempt to resynchronize.
 */

const CR = 0x0d;
const LF = 0x0a;
const STAR = 0x2a; // '*'
const DOLLAR = 0x24; // '$'

/** Longest accepted inline command line. */
const MAX_INLINE_BYTES = 64 * 1024;
/** Longest accepted `*` / `$` header line (a 64-bit number plus slack). */
const MAX_HEADER_BYTES = 32;
/** Largest accepted bulk string payload, matching Redis' proto-max-bulk-len. */
const MAX_BULK_BYTES = 512 * 1024 * 1024;
/** Largest accepted argument count for one command. */
const MAX_MULTIBULK_ELEMENTS = 1024 * 1024;

export class RespProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RespProtocolError';
  }
}

interface ParsedCommand {
  /** Decoded arguments. Empty for blank inline lines and `*0` arrays. */
  args: Buffer[];
  /** Buffer offset immediately after the command. */
  nextPos: number;
}

interface Line {
  /** Line content without the terminator, decoded as latin1 (byte-faithful). */
  text: string;
  nextPos: number;
}

export class RespCommandParser {
  private buffer: Buffer = Buffer.alloc(0);

  /** Number of buffered bytes that do not yet form a complete command. */
  get bufferedBytes(): number {
    return this.buffer.length;
  }

  /**
   * Appends a chunk to the internal buffer and extracts every command that is
   * now complete. Argument buffers are copies, so they stay valid after
   * subsequent `feed()` calls and can be retained by the caller.
   */
  feed(chunk: Buffer): Buffer[][] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    const commands: Buffer[][] = [];
    let pos = 0;
    while (pos < this.buffer.length) {
      const parsed = this.parseCommandAt(pos);
      if (parsed === null) break; // incomplete: wait for more bytes
      pos = parsed.nextPos;
      if (parsed.args.length > 0) commands.push(parsed.args);
    }

    // Drop consumed bytes. subarray() is a view, which is fine: the next feed
    // concatenates into a fresh allocation, and extracted args were copied.
    if (pos > 0) {
      this.buffer = pos === this.buffer.length ? Buffer.alloc(0) : this.buffer.subarray(pos);
    }
    return commands;
  }

  private parseCommandAt(pos: number): ParsedCommand | null {
    if (this.buffer[pos] === STAR) return this.parseMultibulkAt(pos);
    return this.parseInlineAt(pos);
  }

  private parseMultibulkAt(pos: number): ParsedCommand | null {
    const header = this.readLineAt(pos, MAX_HEADER_BYTES);
    if (header === null) return null;

    const count = parseHeaderInt(header.text.slice(1));
    if (count === null || count < 0 || count > MAX_MULTIBULK_ELEMENTS) {
      throw new RespProtocolError('invalid multibulk length');
    }

    let cursor = header.nextPos;
    const args: Buffer[] = [];
    for (let i = 0; i < count; i++) {
      if (cursor >= this.buffer.length) return null;
      const marker = this.buffer[cursor];
      if (marker !== DOLLAR) {
        throw new RespProtocolError(`expected '$', got '${printableByte(marker ?? 0)}'`);
      }

      const lengthLine = this.readLineAt(cursor, MAX_HEADER_BYTES);
      if (lengthLine === null) return null;
      const length = parseHeaderInt(lengthLine.text.slice(1));
      if (length === null || length < 0 || length > MAX_BULK_BYTES) {
        throw new RespProtocolError('invalid bulk length');
      }

      const start = lengthLine.nextPos;
      const end = start + length;
      if (this.buffer.length < end + 2) return null; // payload + CRLF not here yet
      if (this.buffer[end] !== CR || this.buffer[end + 1] !== LF) {
        throw new RespProtocolError('expected CRLF after bulk payload');
      }

      // Copy so the argument does not pin the (potentially large) network
      // buffer, and stays valid after the internal buffer is compacted.
      args.push(Buffer.from(this.buffer.subarray(start, end)));
      cursor = end + 2;
    }
    return { args, nextPos: cursor };
  }

  /**
   * Inline commands: a plain text line split on whitespace. Quoting is not
   * supported; this exists so that `telnet`-style poking works.
   */
  private parseInlineAt(pos: number): ParsedCommand | null {
    const line = this.readLineAt(pos, MAX_INLINE_BYTES);
    if (line === null) return null;
    const text = line.text.trim();
    if (text.length === 0) return { args: [], nextPos: line.nextPos };
    const args = text.split(/\s+/).map((part) => Buffer.from(part, 'latin1'));
    return { args, nextPos: line.nextPos };
  }

  /**
   * Reads one line starting at `pos`. Lines are terminated by LF; a preceding
   * CR is stripped, so both CRLF and bare LF are accepted. Returns null when
   * the terminator has not arrived yet, and throws once an unterminated line
   * exceeds `maxBytes` so a hostile client cannot buffer without bound.
   */
  private readLineAt(pos: number, maxBytes: number): Line | null {
    const lfIndex = this.buffer.indexOf(LF, pos);
    if (lfIndex === -1) {
      if (this.buffer.length - pos > maxBytes) {
        throw new RespProtocolError('too big inline request');
      }
      return null;
    }
    if (lfIndex - pos > maxBytes) {
      throw new RespProtocolError('too big inline request');
    }
    let end = lfIndex;
    if (end > pos && this.buffer[end - 1] === CR) end -= 1;
    return { text: this.buffer.toString('latin1', pos, end), nextPos: lfIndex + 1 };
  }
}

/** Strict decimal integer used by `*` and `$` headers. */
function parseHeaderInt(text: string): number | null {
  if (!/^-?\d+$/.test(text) || text.length > 16) return null;
  return Number(text);
}

function printableByte(byte: number): string {
  if (byte >= 0x20 && byte <= 0x7e) return String.fromCharCode(byte);
  return `\\x${byte.toString(16).padStart(2, '0')}`;
}
