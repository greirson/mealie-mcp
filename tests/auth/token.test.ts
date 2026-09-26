import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashToken } from '../../src/store/crypto.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { mockMealieUser } from '../helpers/mealie.js';
import {
  authorizeUrl, codeFromSuccessPage, exchangeCode, fullLogin, openLoginForm, pkcePair, refreshTokens, registerClient, submitLogin,
} from '../helpers/oauth.js';

let app: TestApp;
beforeEach(async () => { app = await startTestApp(); mockMealieUser(); });
afterEach(async () => { await app.close(); });

async function getCode() {
  const clientId = await registerClient(app.baseUrl);
  const pkce = pkcePair();
  const form = await openLoginForm(authorizeUrl(app.baseUrl, clientId, pkce.challenge));
  const { code } = codeFromSuccessPage(await (await submitLogin(app.baseUrl, form, 'good-token')).text());
  return { clientId, code, ...pkce };
}

describe('POST /token authorization_code', () => {
  it('exchanges a code for tokens with no-store caching', async () => {
    const { clientId, code, verifier } = await getCode();
    const res = await exchangeCode(app.baseUrl, clientId, code, verifier);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'mealie' });
    expect(app.store.getAccessToken(hashToken(body.access_token))).toBeDefined();
  });

  it('rejects a reused code', async () => {
    const { clientId, code, verifier } = await getCode();
    expect((await exchangeCode(app.baseUrl, clientId, code, verifier)).status).toBe(200);
    const again = await exchangeCode(app.baseUrl, clientId, code, verifier);
    expect(again.status).toBe(400);
    expect((await again.json()).error).toBe('invalid_grant');
  });

  it('rejects a wrong PKCE verifier', async () => {
    const { clientId, code } = await getCode();
    const res = await exchangeCode(app.baseUrl, clientId, code, pkcePair().verifier);
    expect((await res.json()).error).toBe('invalid_grant');
  });

  it('rejects a mismatched redirect_uri', async () => {
    const { clientId, code, verifier } = await getCode();
    const res = await exchangeCode(app.baseUrl, clientId, code, verifier, 'https://claude.ai/other');
    expect((await res.json()).error).toBe('invalid_grant');
  });

  it('rejects a code presented by a different client', async () => {
    const { code, verifier } = await getCode();
    const other = await registerClient(app.baseUrl);
    expect((await (await exchangeCode(app.baseUrl, other, code, verifier)).json()).error).toBe('invalid_grant');
  });

  it('rejects unknown clients and grant types', async () => {
    const res = await exchangeCode(app.baseUrl, 'nope', 'x', 'y');
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('invalid_client');
    const clientId = await registerClient(app.baseUrl);
    const bad = await fetch(`${app.baseUrl}/mcp/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password', client_id: clientId }).toString(),
    });
    expect((await bad.json()).error).toBe('unsupported_grant_type');
  });

  it('rejects a missing grant_type as invalid_request, not unsupported_grant_type', async () => {
    const clientId = await registerClient(app.baseUrl);
    const res = await fetch(`${app.baseUrl}/mcp/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId }).toString(),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_request');
  });
});

describe('POST /token refresh_token', () => {
  it('rotates refresh tokens', async () => {
    const login = await fullLogin(app.baseUrl, 'good-token');
    const res = await refreshTokens(app.baseUrl, login.clientId, login.refreshToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.refresh_token).not.toBe(login.refreshToken);
    expect(app.store.getRefreshToken(hashToken(login.refreshToken))?.rotatedAt).not.toBeNull();
  });

  it('concurrent refresh: one succeeds, the reuse revokes the session', async () => {
    const login = await fullLogin(app.baseUrl, 'good-token');
    const sessionId = app.store.getRefreshToken(hashToken(login.refreshToken))!.sessionId;
    const [a, b] = await Promise.all([
      refreshTokens(app.baseUrl, login.clientId, login.refreshToken),
      refreshTokens(app.baseUrl, login.clientId, login.refreshToken),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
    expect(app.store.getSession(sessionId)?.revokedAt).not.toBeNull();
  });

  it('rejects a refresh token presented by another client', async () => {
    const login = await fullLogin(app.baseUrl, 'good-token');
    const other = await registerClient(app.baseUrl);
    expect((await (await refreshTokens(app.baseUrl, other, login.refreshToken)).json()).error).toBe('invalid_grant');
  });
});

describe('POST /revoke', () => {
  it('revokes an access token and always returns 200', async () => {
    const login = await fullLogin(app.baseUrl, 'good-token');
    const res = await fetch(`${app.baseUrl}/mcp/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: login.accessToken, client_id: login.clientId }).toString(),
    });
    expect(res.status).toBe(200);
    expect(app.store.getAccessToken(hashToken(login.accessToken))).toBeUndefined();
    const unknown = await fetch(`${app.baseUrl}/mcp/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'token=nothing',
    });
    expect(unknown.status).toBe(200);
  });

  it('revoking a refresh token invalidates the whole session, including its access token', async () => {
    const login = await fullLogin(app.baseUrl, 'good-token');
    const sessionId = app.store.getRefreshToken(hashToken(login.refreshToken))!.sessionId;
    const res = await fetch(`${app.baseUrl}/mcp/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: login.refreshToken, client_id: login.clientId }).toString(),
    });
    expect(res.status).toBe(200);
    expect(app.store.getSession(sessionId)?.revokedAt).not.toBeNull();
    expect(app.store.getAccessToken(hashToken(login.accessToken))).toBeUndefined();
    expect(app.store.getRefreshToken(hashToken(login.refreshToken))).toBeUndefined();
  });
});
