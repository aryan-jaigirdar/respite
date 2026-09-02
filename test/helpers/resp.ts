/**
 * Minimal RESP2 reply decoder for tests.
 *
 * The production parser only decodes commands (arrays of bulk strings plus
 * inline lines) because that is all a server receives. Tests, acting as a
 * client, need the other direction: simple strings, errors, integers, bulk
 * strings, and arrays. Keeping this separate also means the test suite checks
 * the server's output against an independent implementation of the protocol.
 */

export interface RespErrorReply {
  error: string;
}

export type Reply = string | number | null | RespErrorReply | Reply[];

export function isErrorReply(reply: Reply): reply is RespErrorReply {
  return typeof reply === 'object' && reply !== null && !Array.isArray(reply);
}

/**
 * Attempts to decode one reply starting at `pos`. Returns null when the
 * buffer does not yet contain a complete reply (fragmented stream).
 */
export function tryDecode(buffer: Buffer, pos = 0): { value: Reply; next: number } | null {
  if (pos >= buffer.length) return null;
  const type = String.fromCharCode(buffer[pos]!);
  const line = readLine(buffer, pos + 1);
  if (line === null) return null;

  switch (type) {
    case '+':
      return { value: line.text, next: line.next };
    case '-':
      return { value: { error: line.text }, next: line.next };
    case ':':
      return { value: Number(line.text), next: line.next };
    case '$': {
      const length = Number(line.text);
      if (length === -1) return { value: null, next: line.next };
      const end = line.next + length;
      if (buffer.length < end + 2) return null;
      return { value: buffer.toString('utf8', line.next, end), next: end + 2 };
    }
    case '*': {
      const count = Number(line.text);
      if (count === -1) return { value: null, next: line.next };
      const items: Reply[] = [];
      let cursor = line.next;
      for (let i = 0; i < count; i++) {
        const item = tryDecode(buffer, cursor);
        if (item === null) return null;
        items.push(item.value);
        cursor = item.next;
      }
      return { value: items, next: cursor };
    }
    default:
      throw new Error(`unexpected reply type byte '${type}'`);
  }
}

/** Decodes exactly one complete reply; throws on trailing or missing bytes. */
export function decodeOne(buffer: Buffer): Reply {
  const decoded = tryDecode(buffer, 0);
  if (decoded === null) throw new Error('incomplete reply');
  if (decoded.next !== buffer.length) {
    throw new Error(`trailing bytes after reply: ${buffer.length - decoded.next}`);
  }
  return decoded.value;
}

function readLine(buffer: Buffer, pos: number): { text: string; next: number } | null {
  const index = buffer.indexOf('\r\n', pos, 'latin1');
  if (index === -1) return null;
  return { text: buffer.toString('utf8', pos, index), next: index + 2 };
}
