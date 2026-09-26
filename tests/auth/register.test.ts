import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkRedirectUri } from '../../src/auth/register.js';
import { startTestApp, type TestApp } from '../helpers/app.js';

let app: TestApp;
beforeEach(async () => { app = await startTestApp(); });
afterEach(async () => { await app.close(); });

const register = (body: unknown) =>
  fetch(`${app.baseUrl}/mcp/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const registerUri = async (redirect_uri: string): Promise<Response> => register({ redirect_uris: [redirect_uri] });

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

  it('accepts redirect URIs used by other MCP apps, by default', async () => {
    expect((await registerUri('cursor://anysphere.cursor-mcp/oauth/callback')).status).toBe(201);
    expect((await registerUri('vscode://redirect')).status).toBe(201);
    expect((await registerUri('https://vscode.dev/redirect')).status).toBe(201);
    expect((await registerUri('https://chatgpt.com/connector_platform_oauth_redirect')).status).toBe(201);
    expect((await registerUri('https://chatgpt.com/connector/oauth/abc123')).status).toBe(201);
    expect((await registerUri('http://[::1]:33418/')).status).toBe(201);
    expect((await registerUri('http://127.0.0.1:5555/cb')).status).toBe(201);
  });

  it('rejects dangerous schemes and non-allowlisted web hosts', async () => {
    for (const uri of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'http://evil.example/cb', 'https://evil.example/cb']) {
      const res = await registerUri(uri);
      expect(res.status, uri).toBe(400);
      expect((await res.json()).error).toBe('invalid_redirect_uri');
    }
  });

  it('rejects native app redirects entirely when ALLOW_NATIVE_APP_REDIRECTS is off, but keeps allowlisted loopback hosts working', async () => {
    await app.close();
    app = await startTestApp({ allowNativeAppRedirects: false, allowedRedirectHosts: ['claude.ai', '127.0.0.1'] });
    expect((await registerUri('cursor://anysphere.cursor-mcp/oauth/callback')).status).toBe(400);
    expect((await registerUri('http://127.0.0.1:5555/cb')).status).toBe(201);
    await app.close();
    app = await startTestApp({ allowNativeAppRedirects: false, allowedRedirectHosts: ['claude.ai'] });
    expect((await registerUri('http://127.0.0.1:5555/cb')).status).toBe(400);
  });
});

describe('checkRedirectUri', () => {
  const policy = { allowedRedirectHosts: ['claude.ai', 'chatgpt.com', 'vscode.dev'], allowedRedirectSchemes: ['cursor', 'vscode'], allowNativeAppRedirects: true };
  const strict = { ...policy, allowNativeAppRedirects: false };

  it('accepts allowed https, loopback http/https, and allowlisted custom schemes by default', () => {
    expect(checkRedirectUri('https://claude.ai/cb', policy)).toBeUndefined();
    expect(checkRedirectUri('http://localhost:9999/cb', policy)).toBeUndefined();
    expect(checkRedirectUri('http://127.0.0.1:5555/cb', policy)).toBeUndefined();
    expect(checkRedirectUri('http://[::1]:33418/', policy)).toBeUndefined();
    expect(checkRedirectUri('cursor://anysphere.cursor-mcp/oauth/callback', policy)).toBeUndefined();
    expect(checkRedirectUri('com.example.app:/oauth/callback', { ...policy, allowedRedirectSchemes: ['com.example.app'] })).toBeUndefined();
  });

  it('rejects http on public hosts, fragments, subdomains, and garbage', () => {
    expect(checkRedirectUri('http://claude.ai/cb', policy)).toMatch(/https/);
    expect(checkRedirectUri('https://claude.ai/cb#x', policy)).toMatch(/fragment/);
    expect(checkRedirectUri('https://evil.claude.ai/cb', policy)).toMatch(/not allowed/);
    expect(checkRedirectUri('https://claude.ai@evil.example/cb', policy)).toMatch(/not allowed/);
    expect(checkRedirectUri('http://127.0.0.1.evil.example/cb', policy)).toMatch(/https/);
    expect(checkRedirectUri('not a url', policy)).toMatch(/Invalid/);
  });

  it('rejects a fragment even on an otherwise-allowed custom scheme', () => {
    expect(checkRedirectUri('cursor://anysphere.cursor-mcp/cb#x', policy)).toMatch(/fragment/);
  });

  it('rejects custom schemes that are not allowlisted, including ones that hand the URL to a browser', () => {
    for (const uri of [
      'com.example.app:/oauth/callback',
      'microsoft-edge:https://evil.example/cb',
      'x-safari-https://evil.example/cb',
      'googlechromes://evil.example/cb',
      'ms-word:ofe|u|https://evil.example/doc',
    ]) {
      expect(checkRedirectUri(uri, policy), uri).toMatch(/ALLOWED_REDIRECT_SCHEMES/);
    }
  });

  it('rejects dangerous schemes case-insensitively, even when an operator allowlists them', () => {
    const everything = { ...policy, allowedRedirectSchemes: ['javascript', 'data', 'file', 'vbscript', 'blob', 'about', 'ftp', 'ws', 'wss', 'filesystem', 'view-source', 'intent'] };
    for (const uri of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,x',
      'file:///etc/passwd',
      'vbscript:msgbox(1)',
      'blob:https://example.com/uuid',
      'about:blank',
      'ftp://example.com/x',
      'ws://example.com/x',
      'wss://example.com/x',
      'filesystem:https://example.com/x',
      'view-source:https://example.com',
      'intent://evil.example/cb',
    ]) {
      expect(checkRedirectUri(uri, everything), uri).toMatch(/not allowed/);
    }
  });

  it('kill switch off: rejects any custom scheme and non-allowlisted loopback, keeps https allowlist behavior', () => {
    expect(checkRedirectUri('cursor://anysphere.cursor-mcp/oauth/callback', strict)).toMatch(/http or https/);
    expect(checkRedirectUri('http://127.0.0.1:5555/cb', strict)).toMatch(/not allowed/);
    expect(checkRedirectUri('http://127.0.0.1:5555/cb', { ...strict, allowedRedirectHosts: [...strict.allowedRedirectHosts, '127.0.0.1'] })).toBeUndefined();
    expect(checkRedirectUri('https://claude.ai/cb', strict)).toBeUndefined();
  });
});
