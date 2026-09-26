import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { MEALIE, mockMealieUser } from '../helpers/mealie.js';
import { mswServer } from '../helpers/msw.js';
import { fullLogin } from '../helpers/oauth.js';

let app: TestApp;
beforeEach(async () => {
  app = await startTestApp();
  mockMealieUser();
  mswServer.use(http.get(`${MEALIE}/api/households/self`, () => HttpResponse.json({ id: 'h-1', name: 'Home', slug: 'home' })));
});
afterEach(async () => { await app.close(); });

async function connect(accessToken: string): Promise<Client> {
  const client = new Client({ name: 'e2e', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', app.baseUrl), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } })
  );
  return client;
}

const rawMcp = (token?: string) =>
  fetch(`${app.baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });

describe('MCP end to end', () => {
  it('challenges unauthenticated requests with resource metadata', async () => {
    const res = await rawMcp();
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(`resource_metadata="${app.baseUrl}/.well-known/oauth-protected-resource/mcp"`);
  });

  it('logs in via OAuth and calls mealie_whoami as that user', async () => {
    const { accessToken } = await fullLogin(app.baseUrl, 'good-token');
    const client = await connect(accessToken);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('mealie_whoami');
    const result = await client.callTool({ name: 'mealie_whoami', arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(JSON.parse(text).username).toBe('sam');
    await client.close();
  });

  it('identifies itself with the Mealie title and logo from the Mealie instance', async () => {
    const { accessToken } = await fullLogin(app.baseUrl, 'good-token');
    const client = await connect(accessToken);
    const info = client.getServerVersion();
    expect(info?.name).toBe('mealie-mcp');
    expect(info?.title).toBe('Mealie');
    expect(info?.websiteUrl).toBe('https://mealie.example.com');
    expect(info?.icons).toEqual([
      { src: 'https://mealie.example.com/icons/android-chrome-512x512.png', mimeType: 'image/png', sizes: ['512x512'] },
      { src: 'https://mealie.example.com/icons/android-chrome-192x192.png', mimeType: 'image/png', sizes: ['192x192'] },
    ]);
    await client.close();
  });

  it('revokes the session when Mealie rejects the stored token', async () => {
    const { accessToken } = await fullLogin(app.baseUrl, 'good-token');
    mswServer.use(http.get(`${MEALIE}/api/users/self`, () => HttpResponse.json({ detail: 'x' }, { status: 401 })));
    const client = await connect(accessToken);
    const result = await client.callTool({ name: 'mealie_whoami', arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]!.text).toMatch(/Reconnect/);
    await client.close();
    expect((await rawMcp(accessToken)).status).toBe(401);
  });

  it('encryption key rotated: /mcp answers 401 so Claude re-runs login', async () => {
    const { accessToken } = await fullLogin(app.baseUrl, 'good-token');
    const rotated = await startTestApp({ encryptionKey: Buffer.alloc(32, 99) }, app.store);
    try {
      const res = await fetch(`${rotated.baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      expect(res.status).toBe(401);
    } finally {
      await rotated.close();
    }
  });
});
