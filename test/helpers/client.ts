/**
 * Tiny RESP client over net.Socket for end-to-end tests, so the suite never
 * needs redis-cli. Replies are matched to callers in FIFO order, which is
 * exactly the pipelining contract of the protocol.
 */

import net from 'node:net';
import { encodeCommand } from '../../src/resp/writer.js';
import { tryDecode, type Reply } from './resp.js';

interface Waiter {
  resolve: (reply: Reply) => void;
  reject: (error: Error) => void;
}

export class TestClient {
  readonly closed: Promise<void>;

  private buffer: Buffer = Buffer.alloc(0);
  private readonly ready: Reply[] = [];
  private readonly waiters: Waiter[] = [];

  private constructor(private readonly socket: net.Socket) {
    this.closed = new Promise((resolve) => socket.on('close', () => resolve()));
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('close', () => {
      for (const waiter of this.waiters.splice(0)) {
        waiter.reject(new Error('connection closed'));
      }
    });
    socket.on('error', () => {
      // surfaced through 'close'
    });
  }

  static connect(port: number, host = '127.0.0.1'): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ port, host });
      socket.once('connect', () => resolve(new TestClient(socket)));
      socket.once('error', reject);
    });
  }

  /** Sends one command and resolves with its decoded reply. */
  command(...args: (string | Buffer)[]): Promise<Reply> {
    this.socket.write(encodeCommand(args));
    return this.nextReply();
  }

  /** Writes raw bytes; used to exercise fragmentation and inline commands. */
  writeRaw(data: string | Buffer): void {
    this.socket.write(typeof data === 'string' ? Buffer.from(data, 'latin1') : data);
  }

  /** Resolves with the next decoded reply, in arrival order. */
  nextReply(timeoutMs = 2000): Promise<Reply> {
    const queued = this.ready.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise<Reply>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: (reply) => {
          clearTimeout(timer);
          resolve(reply);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(new Error('timed out waiting for a reply'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  end(): void {
    this.socket.end();
  }

  destroy(): void {
    this.socket.destroy();
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const decoded = tryDecode(this.buffer, 0);
      if (decoded === null) return;
      this.buffer = this.buffer.subarray(decoded.next);
      const waiter = this.waiters.shift();
      if (waiter !== undefined) {
        waiter.resolve(decoded.value);
      } else {
        this.ready.push(decoded.value);
      }
    }
  }
}
