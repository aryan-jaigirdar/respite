#!/usr/bin/env node
/**
 * CLI entry point: parse flags, start the server, log a banner, and shut
 * down gracefully (flushing the AOF) on SIGINT/SIGTERM.
 */

import { RespiteServer } from './server.js';
import { parseCliArgs, CliError, USAGE, type CliOptions } from './config.js';
import { VERSION } from './version.js';

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof CliError) {
      console.error(`respite: ${error.message}`);
      console.error('Run "respite --help" for usage.');
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  if (options.help) {
    console.log(USAGE);
    return;
  }
  if (options.version) {
    console.log(`respite ${VERSION}`);
    return;
  }

  const server = new RespiteServer({
    port: options.port,
    host: options.host,
    maxmemory: options.maxmemory,
    appendonly: options.appendonly,
    logger: (message) => console.log(message),
  });

  let address;
  try {
    address = await server.listen();
  } catch (error) {
    console.error(`respite: failed to start: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  console.log(`respite ${VERSION} listening on ${address.address}:${address.port}`);
  if (options.maxmemory > 0) {
    console.log(`maxmemory: ${options.maxmemory} bytes (allkeys-lru eviction)`);
  }
  if (options.appendonly !== null) {
    console.log(`append only file: ${options.appendonly}`);
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`received ${signal}, shutting down`);
    server
      .close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error(`shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
