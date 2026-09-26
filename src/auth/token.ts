import type { RequestHandler, Response } from 'express';
import { hashToken } from '../store/crypto.js';
import type { AuthDeps } from './index.js';
import { issueTokens, type IssuedTokens } from './issue.js';
import { verifyPkceS256 } from './pkce.js';
import { oauthError } from './respond.js';

function sendTokens(res: Response, tokens: IssuedTokens): void {
  res.status(200).set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' }).json(tokens);
}

export function tokenHandler({ store }: AuthDeps): RequestHandler {
  return (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const str = (key: string) => (typeof body[key] === 'string' ? (body[key] as string) : undefined);

    const clientId = str('client_id');
    const client = clientId ? store.getClient(clientId) : undefined;
    if (!client) return void oauthError(res, 401, 'invalid_client', 'Unknown client_id');

    const grant = str('grant_type');
    if (!grant) return void oauthError(res, 400, 'invalid_request', 'grant_type is required');

    if (grant === 'authorization_code') {
      const code = str('code');
      const verifier = str('code_verifier');
      if (!code || !verifier) return void oauthError(res, 400, 'invalid_request', 'code and code_verifier are required');
      const record = store.consumeAuthCode(hashToken(code));
      if (!record || record.clientId !== client.clientId) {
        return void oauthError(res, 400, 'invalid_grant', 'Authorization code is invalid, expired, or already used');
      }
      if (str('redirect_uri') !== record.redirectUri) return void oauthError(res, 400, 'invalid_grant', 'redirect_uri does not match');
      if (!verifyPkceS256(verifier, record.codeChallenge)) return void oauthError(res, 400, 'invalid_grant', 'PKCE verification failed');
      const session = store.getSession(record.sessionId);
      if (!session || session.revokedAt !== null) return void oauthError(res, 400, 'invalid_grant', 'Session is no longer valid');
      return void sendTokens(res, issueTokens(store, record.sessionId));
    }

    if (grant === 'refresh_token') {
      const refresh = str('refresh_token');
      if (!refresh) return void oauthError(res, 400, 'invalid_request', 'refresh_token is required');
      const hash = hashToken(refresh);
      const record = store.getRefreshToken(hash);
      if (!record) return void oauthError(res, 400, 'invalid_grant', 'Refresh token is invalid');
      const session = store.getSession(record.sessionId);
      if (!session || session.revokedAt !== null || session.clientId !== client.clientId || record.expiresAt <= Date.now()) {
        return void oauthError(res, 400, 'invalid_grant', 'Refresh token is invalid or expired');
      }
      // Reuse of a rotated refresh token signals theft: kill the whole session.
      if (!store.markRefreshTokenRotated(hash)) {
        store.revokeSession(record.sessionId);
        return void oauthError(res, 400, 'invalid_grant', 'Refresh token was already used; the session has been revoked. Reconnect to continue.');
      }
      return void sendTokens(res, issueTokens(store, record.sessionId));
    }

    oauthError(res, 400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
  };
}

export function revokeHandler({ store }: AuthDeps): RequestHandler {
  return (req, res) => {
    const token = (req.body as Record<string, unknown> | undefined)?.token;
    if (typeof token === 'string' && token) {
      const hash = hashToken(token);
      // RFC 7009 SHOULD: revoking a refresh token also invalidates the access tokens issued under
      // the same grant, so kill the whole session rather than only this one refresh token row.
      const refresh = store.getRefreshToken(hash);
      if (refresh) store.revokeSession(refresh.sessionId);
      else store.deleteToken(hash);
    }
    // RFC 7009: respond 200 whether or not the token existed.
    res.status(200).set('Cache-Control', 'no-store').end();
  };
}
