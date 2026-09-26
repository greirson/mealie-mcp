import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const KEY = Buffer.alloc(32, 1).toString('base64');
const base = {
  PUBLIC_URL: 'https://mealie-mcp.example.com',
  MEALIE_URL: 'http://mealie:9000',
  MCP_ENCRYPTION_KEY: KEY,
};

describe('loadConfig', () => {
  it('loads a valid config with defaults', () => {
    const c = loadConfig(base);
    expect(c.publicUrl.href).toBe('https://mealie-mcp.example.com/');
    expect(c.mealieUrl).toBe('http://mealie:9000');
    expect(c.mealiePublicUrl).toBe('http://mealie:9000');
    expect(c.encryptionKey.length).toBe(32);
    expect(c.allowedRedirectHosts).toEqual(['claude.ai', 'claude.com', 'chatgpt.com', 'vscode.dev']);
    expect(c.allowNativeAppRedirects).toBe(true);
    expect(c.trustCloudflare).toBe(false);
    expect(c.authRateLimitPerMinute).toBe(10);
    expect(c.port).toBe(8080);
    expect(c.dataDir).toBe('/data');
    expect(c.logLevel).toBe('info');
  });

  it('reports every missing required variable at once', () => {
    try {
      loadConfig({});
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const problems = (err as ConfigError).problems.join('\n');
      expect(problems).toContain('PUBLIC_URL is required');
      expect(problems).toContain('MEALIE_URL is required');
      expect(problems).toContain('MCP_ENCRYPTION_KEY is required');
    }
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() => loadConfig({ ...base, MCP_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') })).toThrow(/32 bytes/);
  });

  it('rejects http PUBLIC_URL for non-local hosts', () => {
    expect(() => loadConfig({ ...base, PUBLIC_URL: 'http://mealie-mcp.example.com' })).toThrow(/https/);
  });

  it('allows http PUBLIC_URL for localhost', () => {
    expect(loadConfig({ ...base, PUBLIC_URL: 'http://localhost:8080' }).publicUrl.port).toBe('8080');
  });

  it('rejects a PUBLIC_URL with a path', () => {
    expect(() => loadConfig({ ...base, PUBLIC_URL: 'https://example.com/mcp' })).toThrow(/path/);
  });

  it('parses optional variables', () => {
    const c = loadConfig({
      ...base,
      MEALIE_URL: 'http://mealie:9000/',
      MEALIE_PUBLIC_URL: 'https://mealie.example.com/',
      ALLOWED_REDIRECT_HOSTS: ' claude.ai , example.org ',
      TRUST_CLOUDFLARE: 'true',
      AUTH_RATE_LIMIT_PER_MINUTE: '30',
      PORT: '9000',
      DATA_DIR: '/tmp/x',
      LOG_LEVEL: 'debug',
    });
    expect(c.mealieUrl).toBe('http://mealie:9000');
    expect(c.mealiePublicUrl).toBe('https://mealie.example.com');
    expect(c.allowedRedirectHosts).toEqual(['claude.ai', 'example.org']);
    expect(c.trustCloudflare).toBe(true);
    expect(c.authRateLimitPerMinute).toBe(30);
    expect(c.port).toBe(9000);
    expect(c.dataDir).toBe('/tmp/x');
    expect(c.logLevel).toBe('debug');
  });

  it('rejects an invalid PORT', () => {
    expect(() => loadConfig({ ...base, PORT: 'abc' })).toThrow(/PORT/);
  });

  it('enables Mealie session login when the public hosts match', () => {
    const c = loadConfig({ ...base, PUBLIC_URL: 'https://mealie.example.com', MEALIE_PUBLIC_URL: 'https://mealie.example.com' });
    expect(c.mealieSessionLogin).toBe(true);
  });

  it('disables Mealie session login when the public hosts differ', () => {
    const c = loadConfig({ ...base, PUBLIC_URL: 'https://mealie-mcp.example.com', MEALIE_PUBLIC_URL: 'https://mealie.example.com' });
    expect(c.mealieSessionLogin).toBe(false);
  });

  it('disables native app redirects only on the literal string "false"', () => {
    expect(loadConfig({ ...base, ALLOW_NATIVE_APP_REDIRECTS: 'false' }).allowNativeAppRedirects).toBe(false);
    expect(loadConfig({ ...base, ALLOW_NATIVE_APP_REDIRECTS: 'FALSE' }).allowNativeAppRedirects).toBe(true);
    expect(loadConfig({ ...base, ALLOW_NATIVE_APP_REDIRECTS: 'no' }).allowNativeAppRedirects).toBe(true);
    expect(loadConfig({ ...base, ALLOW_NATIVE_APP_REDIRECTS: '' }).allowNativeAppRedirects).toBe(true);
  });
});
