import { hashToken, randomToken } from '../store/crypto.js';
import type { Store } from '../store/repo.js';

export const ACCESS_TTL_MS = 3_600_000;
export const REFRESH_TTL_MS = 30 * 86_400_000;

export interface IssuedTokens {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export function issueTokens(store: Store, sessionId: string, now = Date.now()): IssuedTokens {
  const access = randomToken();
  const refresh = randomToken();
  store.saveAccessToken(hashToken(access), sessionId, now + ACCESS_TTL_MS);
  store.saveRefreshToken(hashToken(refresh), sessionId, now + REFRESH_TTL_MS);
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: 'mealie' };
}
