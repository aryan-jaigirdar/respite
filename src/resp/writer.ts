/**
 * RESP2 reply serialization.
 *
 * Every function returns a ready-to-write Buffer. Replies are built eagerly
 * rather than streamed; individual replies are small, and callers batch
 * pipelined replies into a single socket write.
 */

const CRLF = '\r\n';
const CRLF_BUFFER = Buffer.from(CRLF, 'latin1');

/** `$-1\r\n`, the RESP2 null bulk string ("no such key"). */
export const nullBulk: Buffer = Buffer.from('$-1\r\n', 'latin1');

/** `*-1\r\n`, the RESP2 null array. */
export const nullArray: Buffer = Buffer.from('*-1\r\n', 'latin1');

export function simpleString(value: string): Buffer {
  return Buffer.from(`+${sanitizeLine(value)}${CRLF}`, 'latin1');
}

export function errorReply(message: string): Buffer {
  return Buffer.from(`-${sanitizeLine(message)}${CRLF}`, 'latin1');
}

export function integer(value: number | bigint): Buffer {
  if (typeof value === 'number' && !Number.isInteger(value)) {
    throw new TypeError(`integer reply requires an integer, got ${value}`);
  }
  return Buffer.from(`:${value}${CRLF}`, 'latin1');
}

export function bulk(value: Buffer | string): Buffer {
  const payload = typeof value === 'string' ? Buffer.from(value, 'latin1') : value;
  return Buffer.concat([
    Buffer.from(`$${payload.length}${CRLF}`, 'latin1'),
    payload,
    CRLF_BUFFER,
  ]);
}

/** Serializes an array reply from already-encoded elements (nesting works). */
export function array(items: readonly Buffer[]): Buffer {
  return Buffer.concat([Buffer.from(`*${items.length}${CRLF}`, 'latin1'), ...items]);
}

/**
 * Encodes a command as an array of bulk strings, the client-side framing.
 * Used by the append-only file (whose format is exactly the wire format) and
 * by test clients.
 */
export function encodeCommand(args: readonly (string | Buffer)[]): Buffer {
  return array(args.map((arg) => bulk(arg)));
}

/**
 * Simple strings and errors are line-based, so embedded newlines would break
 * framing. Replace them defensively; command handlers never produce them.
 */
function sanitizeLine(value: string): string {
  return value.replace(/[\r\n]/g, ' ');
}
