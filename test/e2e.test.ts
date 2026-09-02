/**
 * End-to-end tests over a real TCP socket, using the minimal RESP client in
 * test/helpers. This exercises the full path a redis-cli session would take:
 * socket, streaming parser, dispatch, reply serialization.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { encodeCommand } from '../src/resp/writer.js';
import { RespiteServer } from '../src/server.js';
import { TestClient } from './helpers/client.js';
import { isErrorReply } from './helpers/resp.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let server: RespiteServer;
let port: number;
const clients: TestClient[] = [];

async function connect(): Promise<TestClient> {
  const client = await TestClient.connect(port);
  clients.push(client);
  return client;
}

beforeAll(async () => {
  server = new RespiteServer({ port: 0 }); // ephemeral port
  const address = await server.listen();
  port = address.port;
});

afterAll(async () => {
  await server.close();
});

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.destroy();
    await client.closed;
  }
  const flush = await TestClient.connect(port);
  await flush.command('FLUSHALL');
  flush.destroy();
  await flush.closed;
});

describe('end to end over a real socket', () => {
  it('answers PING and ECHO', async () => {
    const client = await connect();
    expect(await client.command('PING')).toBe('PONG');
    expect(await client.command('PING', 'hello')).toBe('hello');
    expect(await client.command('ECHO', 'respite')).toBe('respite');
  });

  it('runs a SET / GET / DEL round trip', async () => {
    const client = await connect();
    expect(await client.command('SET', 'greeting', 'hello world')).toBe('OK');
    expect(await client.command('GET', 'greeting')).toBe('hello world');
    expect(await client.command('DEL', 'greeting')).toBe(1);
    expect(await client.command('GET', 'greeting')).toBeNull();
  });

  it('supports SET with EX plus TTL inspection', async () => {
    const client = await connect();
    expect(await client.command('SET', 'session', 'abc', 'EX', '100')).toBe('OK');
    const ttl = await client.command('TTL', 'session');
    expect(typeof ttl).toBe('number');
    expect(ttl as number).toBeGreaterThan(95);
    expect(ttl as number).toBeLessThanOrEqual(100);
  });

  it('actually expires keys (real clock)', async () => {
    const client = await connect();
    await client.command('SET', 'shortlived', 'x', 'PX', '80');
    expect(await client.command('GET', 'shortlived')).toBe('x');
    await sleep(140);
    expect(await client.command('GET', 'shortlived')).toBeNull();
  });

  it('INCR works over the wire', async () => {
    const client = await connect();
    expect(await client.command('INCR', 'hits')).toBe(1);
    expect(await client.command('INCRBY', 'hits', '9')).toBe(10);
  });

  it('handles pipelined commands written in one chunk', async () => {
    const client = await connect();
    client.writeRaw(
      Buffer.concat([
        encodeCommand(['SET', 'p', '1']),
        encodeCommand(['INCR', 'p']),
        encodeCommand(['GET', 'p']),
      ]),
    );
    expect(await client.nextReply()).toBe('OK');
    expect(await client.nextReply()).toBe(2);
    expect(await client.nextReply()).toBe('2');
  });

  it('handles a command fragmented across many writes', async () => {
    const client = await connect();
    const wire = encodeCommand(['SET', 'frag', 'mented']);
    for (let i = 0; i < wire.length; i += 3) {
      client.writeRaw(wire.subarray(i, i + 3));
      await sleep(2);
    }
    expect(await client.nextReply()).toBe('OK');
    expect(await client.command('GET', 'frag')).toBe('mented');
  });

  it('accepts inline commands', async () => {
    const client = await connect();
    client.writeRaw('PING\r\n');
    expect(await client.nextReply()).toBe('PONG');
    client.writeRaw('SET inline yes\r\n');
    expect(await client.nextReply()).toBe('OK');
    expect(await client.command('GET', 'inline')).toBe('yes');
  });

  it('reports unknown commands without dropping the connection', async () => {
    const client = await connect();
    const reply = await client.command('LPUSH', 'k', 'v');
    expect(isErrorReply(reply) && reply.error).toBe("ERR unknown command 'LPUSH'");
    expect(await client.command('PING')).toBe('PONG'); // still alive
  });

  it('replies to a protocol error and closes the connection', async () => {
    const client = await connect();
    client.writeRaw('*1\r\n+BAD\r\n');
    const reply = await client.nextReply();
    expect(isErrorReply(reply)).toBe(true);
    expect(isErrorReply(reply) && reply.error).toMatch(/^ERR Protocol error:/);
    await client.closed; // server hangs up after a protocol error
  });

  it('QUIT replies OK and closes the connection', async () => {
    const client = await connect();
    expect(await client.command('QUIT')).toBe('OK');
    await client.closed;
  });

  it('serves INFO with server metadata', async () => {
    const client = await connect();
    const info = await client.command('INFO');
    expect(typeof info).toBe('string');
    expect(info as string).toContain('respite_version:0.1.0');
    expect(info as string).toContain(`tcp_port:${port}`);
    expect(info as string).toContain('connected_clients:');
  });

  it('COMMAND returns an empty array (redis-cli handshake)', async () => {
    const client = await connect();
    expect(await client.command('COMMAND', 'DOCS')).toEqual([]);
  });

  it('serves multiple concurrent clients independently', async () => {
    const first = await connect();
    const second = await connect();
    await first.command('SET', 'shared', 'from-first');
    expect(await second.command('GET', 'shared')).toBe('from-first');
    const [a, b] = await Promise.all([first.command('PING'), second.command('PING')]);
    expect(a).toBe('PONG');
    expect(b).toBe('PONG');
  });

  it('is binary safe over the wire', async () => {
    const client = await connect();
    const payload = Buffer.from([0x00, 0x0d, 0x0a, 0x01, 0xff]);
    expect(await client.command('SET', 'bin', payload)).toBe('OK');
    expect(await client.command('STRLEN', 'bin')).toBe(5);
  });

  it('SCAN walks the keyspace over the wire', async () => {
    const client = await connect();
    for (let i = 0; i < 12; i++) {
      await client.command('SET', `scan:${i}`, 'v');
    }
    const seen = new Set<string>();
    let cursor = '0';
    do {
      const reply = (await client.command('SCAN', cursor, 'MATCH', 'scan:*', 'COUNT', '5')) as [
        string,
        string[],
      ];
      cursor = reply[0];
      for (const key of reply[1]) seen.add(key);
    } while (cursor !== '0');
    expect(seen.size).toBe(12);
  });
});
