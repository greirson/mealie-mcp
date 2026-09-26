import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkRedirectUri } from '../../src/auth/register.js';
import { startTestApp, type TestApp } from '../helpers/app.js';

let app: TestApp;
beforeEach(async () => { app = await startTestApp(); });
afterEach(async () => { await app.close(); });

const register = (body: unknown) =>
  fetch(`${app.baseUrl}/mcp/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /register', () => {
  it('registers a public client with an allowed redirect', async () => {
    const res = await register({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.client_id).toMatch(/[0-9a-f-]{36}/);
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(app.store.getClient(body.client_id)?.redirectUris).toEqual(['https://claude.ai/api/mcp/auth_callback']);
  });

  it('allows http localhost redirects with a port', async () => {
    expect((await register({ redirect_uris: ['http://localhost:33418/callback'] })).status).toBe(201);
  });

  it('rejects redirect hosts outside the allowlist', async () => {
    const res = await register({ redirect_uris: ['https://evil.example.com/cb'] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_redirect_uri');
  });

  it('rejects confidential clients and missing redirect_uris', async () => {
    expect((await register({ redirect_uris: ['https://claude.ai/cb'], token_endpoint_auth_method: 'client_secret_basic' })).status).toBe(400);
    const res = await register({ client_name: 'x' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_client_metadata');
  });

  it('returns a JSON oauth error for malformed request bodies instead of the default HTML error page', async () => {
    const res = await fetch(`${app.baseUrl}/mcp/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad json',
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = await res.json();
    expect(body.error).toBe('invalid_request');
    expect(body.error_description).toBeTypeOf('string');
  });
});

describe('checkRedirectUri', () => {
  const hosts = ['claude.ai', 'localhost'];
  it('accepts allowed https and local http', () => {
    expect(checkRedirectUri('https://claude.ai/cb', hosts)).toBeUndefined();
    expect(checkRedirectUri('http://localhost:9999/cb', hosts)).toBeUndefined();
  });
  it('rejects http on public hosts, fragments, subdomains, and garbage', () => {
    expect(checkRedirectUri('http://claude.ai/cb', hosts)).toMatch(/https/);
    expect(checkRedirectUri('https://claude.ai/cb#x', hosts)).toMatch(/fragment/);
    expect(checkRedirectUri('https://evil.claude.ai/cb', hosts)).toMatch(/not allowed/);
    expect(checkRedirectUri('not a url', hosts)).toMatch(/Invalid/);
  });
});
