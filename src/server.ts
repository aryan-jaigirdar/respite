/**
 * TCP front end: accepts connections, runs one streaming RESP parser per
 * socket, dispatches decoded commands to the engine, and writes replies.
 * Replies for commands pipelined in one chunk are batched into one write.
 */

import net from 'node:net';
import { RespCommandParser, RespProtocolError } from './resp/parser.js';
import { errorReply } from './resp/writer.js';
import { Engine, type EngineOptions } from './engine.js';

export const DEFAULT_PORT = 6380;
export const DEFAULT_HOST = '127.0.0.1';

export interface RespiteServerOptions extends EngineOptions {
  host?: string;
  logger?: (message: string) => void;
}

export class RespiteServer {
  readonly engine: Engine;

  private readonly server: net.Server;
  private readonly clients = new Set<net.Socket>();
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly logger: (message: string) => void;

  constructor(options: RespiteServerOptions = {}) {
    this.host = options.host ?? DEFAULT_HOST;
    this.requestedPort = options.port ?? DEFAULT_PORT;
    this.logger = options.logger ?? (() => undefined);
    this.engine = new Engine({ ...options, logger: this.logger });
    this.engine.connectedClients = () => this.clients.size;
    this.server = net.createServer((socket) => this.handleConnection(socket));
  }

  get connectedClients(): number {
    return this.clients.size;
  }

  /** Replays the AOF, then binds. Resolves with the bound address. */
  async listen(): Promise<net.AddressInfo> {
    const opened = this.engine.open();
    if (opened.replayedCommands > 0) {
      this.logger(`AOF: replayed ${opened.replayedCommands} commands`);
    }

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.server.once('error', onError);
      this.server.listen(this.requestedPort, this.host, () => {
        this.server.off('error', onError);
        resolve();
      });
    });

    const address = this.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('server bound to a non-TCP address');
    }
    this.engine.setAdvertisedPort(address.port);
    return address;
  }

  /** Destroys open connections, unbinds, and flushes the AOF. */
  async close(): Promise<void> {
    for (const socket of this.clients) socket.destroy();
    this.clients.clear();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
    this.engine.close();
  }

  private handleConnection(socket: net.Socket): void {
    this.engine.stats.totalConnections += 1;
    this.clients.add(socket);
    socket.setNoDelay(true);

    const parser = new RespCommandParser();

    socket.on('data', (chunk: Buffer) => {
      let commands: Buffer[][];
      try {
        commands = parser.feed(chunk);
      } catch (error) {
        // Redis behavior: report the protocol error, then drop the client.
        // The stream offset is unrecoverable, so resynchronizing is unsafe.
        const message = error instanceof RespProtocolError ? error.message : 'parser failure';
        socket.write(errorReply(`ERR Protocol error: ${message}`));
        socket.end();
        return;
      }
      if (commands.length === 0) return;

      const replies: Buffer[] = [];
      let close = false;
      for (const command of commands) {
        let reply: Buffer;
        try {
          const result = this.engine.execute(command);
          reply = result.reply;
          close = result.close === true;
        } catch (error) {
          // A handler bug must not take the server down with it.
          this.logger(`command failed: ${error instanceof Error ? error.message : String(error)}`);
          reply = errorReply('ERR internal error');
        }
        replies.push(reply);
        if (close) break;
      }

      socket.write(replies.length === 1 ? replies[0]! : Buffer.concat(replies));
      if (close) socket.end();
    });

    socket.on('error', () => socket.destroy());
    socket.on('close', () => this.clients.delete(socket));
  }
}
