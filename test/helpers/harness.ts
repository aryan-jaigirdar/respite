/**
 * Command-level test harness: an Engine with a manually driven clock and a
 * `run` helper that executes a command and decodes the reply.
 */

import { Engine, type EngineOptions } from '../../src/engine.js';
import { decodeOne, type Reply } from './resp.js';

export interface Harness {
  engine: Engine;
  /** Mutable fake time in ms; the engine's clock reads it. */
  clock: { now: number };
  run: (...args: (string | Buffer)[]) => Reply;
}

export function makeHarness(options: Omit<EngineOptions, 'clock'> = {}): Harness {
  const clock = { now: 1_000_000 };
  const engine = new Engine({ ...options, clock: () => clock.now });
  const run = (...args: (string | Buffer)[]): Reply => {
    const buffers = args.map((arg) => (typeof arg === 'string' ? Buffer.from(arg, 'latin1') : arg));
    return decodeOne(engine.execute(buffers).reply);
  };
  return { engine, clock, run };
}
