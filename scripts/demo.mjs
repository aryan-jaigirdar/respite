import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../dist/index.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'respite-demo-'));
const file = path.join(directory, 'demo.aof');
const clock = { now: 1000 };
const engines = [];
function open(maxmemory = 0) {
  const engine = new Engine({ appendonly: file, maxmemory, clock: () => clock.now });
  engine.open();
  engines.push(engine);
  return engine;
}
function command(engine, ...args) {
  const reply = engine.execute(args.map((arg) => Buffer.from(arg))).reply.toString('latin1');
  console.log(`  ${args.join(' ').padEnd(24)} ${JSON.stringify(reply)}`);
  assert.notEqual(reply[0], '-', 'demo command failed');
  return reply;
}
function keys(engine) {
  return [...engine.store.snapshot()].map(({ key, value }) => [key, value.toString('utf8')]).sort();
}

try {
  console.log('respite · a working cache, from wire reply to restart');
  console.log('\n1. Exact LRU with a two-entry memory ceiling');
  const first = open(140);
  command(first, 'MSET', 'k1', 'aaaa', 'k2', 'bbbb');
  command(first, 'GET', 'k1');
  command(first, 'SET', 'k3', 'cccc');
  assert.deepEqual(keys(first), [['k1', 'aaaa'], ['k3', 'cccc']]);
  console.log('  live keys:', JSON.stringify(keys(first)));
  first.close();

  console.log('\n2. Replay the actual evictions, even though reads were not logged');
  const restarted = open(140);
  assert.deepEqual(keys(restarted), [['k1', 'aaaa'], ['k3', 'cccc']]);
  console.log('  after restart:', JSON.stringify(keys(restarted)));
  restarted.close();

  console.log('\n3. Expiry survives a restart (using an injected clock)');
  const roomy = open();
  command(roomy, 'SET', 'session', 'token', 'PX', '50');
  clock.now += 50;
  assert.equal(command(roomy, 'GET', 'session'), '$-1\r\n');
  roomy.close();
  clock.now = 1000;
  const rewound = open();
  assert.equal(command(rewound, 'GET', 'session'), '$-1\r\n');

  console.log('\n4. Replay historical mutations before applying the restart clock');
  command(rewound, 'SET', 'temporary', '1', 'PX', '50');
  assert.equal(command(rewound, 'INCR', 'temporary'), ':2\r\n');
  command(rewound, 'SET', 'retained', '1', 'PX', '50');
  assert.equal(command(rewound, 'INCR', 'retained'), ':2\r\n');
  assert.equal(command(rewound, 'PERSIST', 'retained'), ':1\r\n');
  rewound.close();
  clock.now = 1100;
  const later = open();
  assert.equal(command(later, 'GET', 'temporary'), '$-1\r\n');
  assert.equal(command(later, 'GET', 'retained'), '$1\r\n2\r\n');
  assert.equal(command(later, 'PTTL', 'retained'), ':-1\r\n');

  console.log('\n5. Compact mutation history without changing the dataset');
  for (let i = 0; i < 50; i++) later.execute([Buffer.from('INCR'), Buffer.from('counter')]);
  const before = fs.statSync(file).size;
  const expected = keys(later);
  command(later, 'BGREWRITEAOF');
  const after = fs.statSync(file).size;
  assert.ok(after < before);
  later.close();
  const compacted = open();
  assert.deepEqual(keys(compacted), expected);
  assert.equal(compacted.store.get('counter').toString(), '50');
  console.log('  AOF is smaller; all values survive replay.');
  console.log('\nAll demo assertions passed. No external Redis server required.');
} finally {
  for (const engine of engines) engine.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
