import { OAuthError, OAuthErrorCode, type AuthInfo, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { decrypt, hashToken } from '../store/crypto.js';
import type { Store } from '../store/repo.js';

export interface McpAuthExtra {
  sessionId: string;
  mealieToken: string;
  mealieUsername: string;
}

export function createVerifier(store: Store, key: Buffer, now: () => number = Date.now): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const record = store.getAccessToken(hashToken(token));
      if (!record || record.expiresAt <= now()) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Access token is invalid or expired');
      const session = store.getSession(record.sessionId);
      if (!session || session.revokedAt !== null) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Session was revoked');
      let mealieToken: string;
      try {
        mealieToken = decrypt(key, session.mealieTokenEnc);
      } catch {
        // Key rotated or row corrupted: force a fresh login instead of failing every call.
        store.revokeSession(session.sessionId);
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'Stored credentials can no longer be read. Reconnect.');
      }
      const extra: McpAuthExtra = { sessionId: session.sessionId, mealieToken, mealieUsername: session.mealieUsername };
      return {
        token,
        clientId: session.clientId,
        scopes: ['mealie'],
        expiresAt: Math.floor(record.expiresAt / 1000),
        extra: extra as unknown as Record<string, unknown>,
      };
    },
  };
}
