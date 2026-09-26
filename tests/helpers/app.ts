import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Config } from '../../src/config.js';
import { createApp } from '../../src/http/app.js';
import { createLogger } from '../../src/log.js';
import { openDb } from '../../src/store/db.js';
import { Store } from '../../src/store/repo.js';
import { MEALIE } from './mealie.js';

export interface TestApp {
  baseUrl: string;
  config: Config;
  store: Store;
  close(): Promise<void>;
}

export interface StartTestAppOptions {
  /** When true, mealiePublicUrl is set to this app's own base URL so its host matches publicUrl. */
  sessionLogin?: boolean;
}

export async function startTestApp(
  overrides: Partial<Config> = {},
  store = new Store(openDb(':memory:')),
  options: StartTestAppOptions = {}
): Promise<TestApp> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  const config: Config = {
    publicUrl: new URL(baseUrl),
    mealieUrl: MEALIE,
    mealiePublicUrl: options.sessionLogin ? baseUrl : 'https://mealie.example.com',
    mealieSessionLogin: options.sessionLogin ?? false,
    encryptionKey: Buffer.alloc(32, 7),
    allowedRedirectHosts: ['claude.ai', 'claude.com', 'localhost', '127.0.0.1'],
    trustCloudflare: false,
    authRateLimitPerMinute: 1000,
    port,
    dataDir: ':memory:',
    logLevel: 'silent',
    ...overrides,
  };
  const app = createApp({ config, store, logger: createLogger('silent') });
  server.on('request', app);
  return {
    baseUrl,
    config,
    store,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
