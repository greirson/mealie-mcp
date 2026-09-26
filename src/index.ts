#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError, loadConfig } from './config.js';
import { createApp } from './http/app.js';
import { createLogger } from './log.js';
import { openDb } from './store/db.js';
import { Store } from './store/repo.js';
import { VERSION } from './version.js';

const SWEEP_INTERVAL_MS = 10 * 60_000;

function main(): void {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  mkdirSync(config.dataDir, { recursive: true });
  const store = new Store(openDb(join(config.dataDir, 'mealie-mcp.db')));

  const sweep = setInterval(() => {
    try {
      logger.debug(store.sweep(), 'sweep');
    } catch (err) {
      logger.warn({ err }, 'sweep failed');
    }
  }, SWEEP_INTERVAL_MS);
  sweep.unref();

  const app = createApp({ config, store, logger });
  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, publicUrl: config.publicUrl.href, mealieUrl: config.mealieUrl, version: VERSION }, 'mealie-mcp listening');
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    clearInterval(sweep);
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

try {
  main();
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
}
