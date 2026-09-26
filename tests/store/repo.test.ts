import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { Store } from '../../src/store/repo.js';

let now = 1_000_000;
let store: Store;

beforeEach(() => {
  now = 1_000_000;
  store = new Store(openDb(':memory:'), () => now);
});

function seedSession() {
  const client = store.createClient({ clientName: 'Claude', redirectUris: ['https://claude.ai/cb'] });
  const session = store.createSession({ mealieUserId: 'u1', mealieUsername: 'sam', mealieTokenEnc: 'v1.x.y.z', clientId: client.clientId });
  return { client, session };
}

describe('Store', () => {
  it('creates and reads clients', () => {
    const c = store.createClient({ clientName: 'Claude', redirectUris: ['https://claude.ai/cb'] });
    expect(c.clientId).toMatch(/[0-9a-f-]{36}/);
    expect(store.getClient(c.clientId)).toEqual(c);
    expect(store.getClient('nope')).toBeUndefined();
  });

  it('creates, reads, and revokes sessions', () => {
    const { session } = seedSession();
    expect(store.getSession(session.sessionId)?.revokedAt).toBeNull();
    store.saveAccessToken('a1', session.sessionId, now + 1000);
    store.saveRefreshToken('r1', session.sessionId, now + 1000);
    store.revokeSession(session.sessionId);
    expect(store.getSession(session.sessionId)?.revokedAt).toBe(now);
    expect(store.getAccessToken('a1')).toBeUndefined();
    expect(store.getRefreshToken('r1')).toBeUndefined();
  });

  it('consumes an auth code exactly once and only before expiry', () => {
    const { client, session } = seedSession();
    const rec = { sessionId: session.sessionId, clientId: client.clientId, redirectUri: 'https://claude.ai/cb', codeChallenge: 'ch', expiresAt: now + 60_000 };
    store.createAuthCode('h1', rec);
    expect(store.consumeAuthCode('h1')).toEqual(rec);
    expect(store.consumeAuthCode('h1')).toBeUndefined();

    store.createAuthCode('h2', { ...rec, expiresAt: now + 10 });
    now += 11;
    expect(store.consumeAuthCode('h2')).toBeUndefined();
  });

  it('stores tokens and rotates refresh tokens atomically', () => {
    const { session } = seedSession();
    store.saveAccessToken('a1', session.sessionId, now + 3600_000);
    expect(store.getAccessToken('a1')).toEqual({ sessionId: session.sessionId, expiresAt: now + 3600_000 });
    store.saveRefreshToken('r1', session.sessionId, now + 5000);
    expect(store.markRefreshTokenRotated('r1')).toBe(true);
    expect(store.markRefreshTokenRotated('r1')).toBe(false);
    expect(store.getRefreshToken('r1')?.rotatedAt).toBe(now);
  });

  it('deletes a token from either table', () => {
    const { session } = seedSession();
    store.saveAccessToken('a1', session.sessionId, now + 1000);
    store.saveRefreshToken('r1', session.sessionId, now + 1000);
    store.deleteToken('a1');
    store.deleteToken('r1');
    expect(store.getAccessToken('a1')).toBeUndefined();
    expect(store.getRefreshToken('r1')).toBeUndefined();
  });

  it('sweeps expired rows and dead sessions', () => {
    const { client, session } = seedSession();
    store.createAuthCode('c1', { sessionId: session.sessionId, clientId: client.clientId, redirectUri: 'x', codeChallenge: 'y', expiresAt: now + 10 });
    store.saveAccessToken('a1', session.sessionId, now + 10);
    store.saveRefreshToken('r1', session.sessionId, now + 10);
    now += 2 * 86_400_000;
    const result = store.sweep();
    expect(result).toEqual({ codes: 1, accessTokens: 1, refreshTokens: 1, sessions: 1 });
    expect(store.getSession(session.sessionId)).toBeUndefined();
  });

  it('keeps sessions that still have a live refresh token', () => {
    const { session } = seedSession();
    store.saveRefreshToken('r1', session.sessionId, now + 30 * 86_400_000);
    now += 2 * 86_400_000;
    expect(store.sweep().sessions).toBe(0);
    expect(store.getSession(session.sessionId)).toBeDefined();
  });

  it('closes the underlying database', () => {
    store.close();
    expect(() => store.getClient('nope')).toThrow();
  });
});
