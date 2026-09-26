import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app.js';

let app: TestApp;
beforeEach(async () => { app = await startTestApp(); });
afterEach(async () => { await app.close(); });

describe('OAuth metadata', () => {
  it('serves authorization server metadata', async () => {
    const res = await fetch(`${app.baseUrl}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      issuer: `${app.baseUrl}/`,
      authorization_endpoint: `${app.baseUrl}/mcp/oauth/authorize`,
      token_endpoint: `${app.baseUrl}/mcp/oauth/token`,
      registration_endpoint: `${app.baseUrl}/mcp/oauth/register`,
      revocation_endpoint: `${app.baseUrl}/mcp/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  });

  it('keeps every OAuth path routable by one tunnel rule: ^/(mcp|\\.well-known/oauth-)', async () => {
    // A reverse proxy can share the hostname with Mealie by forwarding only these prefixes.
    // Mealie owns /register (invite sign-up), so no MCP route may live outside them.
    const TUNNEL_RULE = /^\/(mcp|\.well-known\/oauth-)/;
    const body = await (await fetch(`${app.baseUrl}/.well-known/oauth-authorization-server`)).json();
    for (const key of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint', 'revocation_endpoint']) {
      expect(new URL(body[key]).pathname, key).toMatch(TUNNEL_RULE);
    }
    for (const old of ['/register', '/authorize', '/token', '/revoke']) {
      const res = await fetch(`${app.baseUrl}${old}`, { method: 'POST' });
      expect(res.status, old).toBe(404);
    }
  });

  it('serves protected resource metadata for /mcp', async () => {
    const res = await fetch(`${app.baseUrl}/.well-known/oauth-protected-resource/mcp`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resource).toBe(`${app.baseUrl}/mcp`);
    expect(body.authorization_servers).toEqual([`${app.baseUrl}/`]);
  });
});
