import { OAuthError } from '@modelcontextprotocol/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { issueTokens } from '../../src/auth/issue.js';
import { createVerifier } from '../../src/auth/verifier.js';
import { encrypt } from '../../src/store/crypto.js';
import { openDb } from '../../src/store/db.js';
import { Store } from '../../src/store/repo.js';

const key = Buffer.alloc(32, 9);
let store: Store;
let sessionId: string;

beforeEach(() => {
  store = new Store(openDb(':memory:'));
  const client = store.createClient({ clientName: 'c', redirectUris: ['https://claude.ai/cb'] });
  sessionId = store.createSession({ mealieUserId: 'u1', mealieUsername: 'sam', mealieTokenEnc: encrypt(key, 'mealie-tok'), clientId: client.clientId }).sessionId;
});

describe('createVerifier', () => {
  it('returns AuthInfo with the decrypted Mealie token in extra', async () => {
    const { access_token } = issueTokens(store, sessionId);
    const info = await createVerifier(store, key).verifyAccessToken(access_token);
    expect(info.extra).toEqual({ sessionId, mealieToken: 'mealie-tok', mealieUsername: 'sam' });
    expect(info.scopes).toEqual(['mealie']);
    expect(info.expiresAt).toBeGreaterThan(Date.now() / 1000);
  });

  it('rejects unknown and expired tokens', async () => {
    await expect(createVerifier(store, key).verifyAccessToken('nope')).rejects.toBeInstanceOf(OAuthError);
    const { access_token } = issueTokens(store, sessionId, Date.now() - 2 * 3_600_000);
    await expect(createVerifier(store, key).verifyAccessToken(access_token)).rejects.toBeInstanceOf(OAuthError);
  });

  it('rejects tokens of a revoked session', async () => {
    const { access_token } = issueTokens(store, sessionId);
    store.revokeSession(sessionId);
    await expect(createVerifier(store, key).verifyAccessToken(access_token)).rejects.toBeInstanceOf(OAuthError);
  });

  it('encryption key rotated: rejects with invalid_token and revokes the session', async () => {
    const { access_token } = issueTokens(store, sessionId);
    const err = await createVerifier(store, Buffer.alloc(32, 1)).verifyAccessToken(access_token).catch((e) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).code).toBe('invalid_token');
    expect(store.getSession(sessionId)?.revokedAt).not.toBeNull();
  });
});
