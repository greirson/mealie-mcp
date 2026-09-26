import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface ClientRecord { clientId: string; clientName: string | null; redirectUris: string[]; createdAt: number }
export interface SessionRecord {
  sessionId: string; mealieUserId: string; mealieUsername: string; mealieTokenEnc: string;
  clientId: string; createdAt: number; revokedAt: number | null;
}
export interface AuthCodeRecord { sessionId: string; clientId: string; redirectUri: string; codeChallenge: string; expiresAt: number }
export interface TokenRecord { sessionId: string; expiresAt: number }
export interface RefreshTokenRecord extends TokenRecord { rotatedAt: number | null }

type Row = Record<string, unknown>;
const DAY_MS = 86_400_000;

export class Store {
  constructor(private readonly db: DatabaseSync, private readonly now: () => number = Date.now) {}

  createClient(input: { clientName: string | null; redirectUris: string[] }): ClientRecord {
    const record: ClientRecord = { clientId: randomUUID(), clientName: input.clientName, redirectUris: input.redirectUris, createdAt: this.now() };
    this.db
      .prepare('INSERT INTO clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)')
      .run(record.clientId, record.clientName, JSON.stringify(record.redirectUris), record.createdAt);
    return record;
  }

  getClient(clientId: string): ClientRecord | undefined {
    const row = this.db.prepare('SELECT * FROM clients WHERE client_id = ?').get(clientId) as Row | undefined;
    if (!row) return undefined;
    return {
      clientId: row.client_id as string,
      clientName: (row.client_name as string | null) ?? null,
      redirectUris: JSON.parse(row.redirect_uris as string) as string[],
      createdAt: Number(row.created_at),
    };
  }

  createSession(input: { mealieUserId: string; mealieUsername: string; mealieTokenEnc: string; clientId: string }): SessionRecord {
    const record: SessionRecord = { sessionId: randomUUID(), ...input, createdAt: this.now(), revokedAt: null };
    this.db
      .prepare('INSERT INTO sessions (session_id, mealie_user_id, mealie_username, mealie_token_enc, client_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(record.sessionId, record.mealieUserId, record.mealieUsername, record.mealieTokenEnc, record.clientId, record.createdAt);
    return record;
  }

  getSession(sessionId: string): SessionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as Row | undefined;
    if (!row) return undefined;
    return {
      sessionId: row.session_id as string,
      mealieUserId: row.mealie_user_id as string,
      mealieUsername: row.mealie_username as string,
      mealieTokenEnc: row.mealie_token_enc as string,
      clientId: row.client_id as string,
      createdAt: Number(row.created_at),
      revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    };
  }

  revokeSession(sessionId: string): void {
    this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL').run(this.now(), sessionId);
    this.db.prepare('DELETE FROM access_tokens WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM refresh_tokens WHERE session_id = ?').run(sessionId);
  }

  createAuthCode(codeHash: string, input: AuthCodeRecord): void {
    this.db
      .prepare('INSERT INTO auth_codes (code_hash, session_id, client_id, redirect_uri, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(codeHash, input.sessionId, input.clientId, input.redirectUri, input.codeChallenge, input.expiresAt);
  }

  consumeAuthCode(codeHash: string): AuthCodeRecord | undefined {
    const now = this.now();
    const result = this.db
      .prepare('UPDATE auth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?')
      .run(now, codeHash, now);
    if (Number(result.changes) !== 1) return undefined;
    const row = this.db.prepare('SELECT * FROM auth_codes WHERE code_hash = ?').get(codeHash) as Row;
    return {
      sessionId: row.session_id as string,
      clientId: row.client_id as string,
      redirectUri: row.redirect_uri as string,
      codeChallenge: row.code_challenge as string,
      expiresAt: Number(row.expires_at),
    };
  }

  saveAccessToken(tokenHash: string, sessionId: string, expiresAt: number): void {
    this.db.prepare('INSERT INTO access_tokens (token_hash, session_id, expires_at) VALUES (?, ?, ?)').run(tokenHash, sessionId, expiresAt);
  }

  getAccessToken(tokenHash: string): TokenRecord | undefined {
    const row = this.db.prepare('SELECT * FROM access_tokens WHERE token_hash = ?').get(tokenHash) as Row | undefined;
    return row ? { sessionId: row.session_id as string, expiresAt: Number(row.expires_at) } : undefined;
  }

  saveRefreshToken(tokenHash: string, sessionId: string, expiresAt: number): void {
    this.db.prepare('INSERT INTO refresh_tokens (token_hash, session_id, expires_at) VALUES (?, ?, ?)').run(tokenHash, sessionId, expiresAt);
  }

  getRefreshToken(tokenHash: string): RefreshTokenRecord | undefined {
    const row = this.db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?').get(tokenHash) as Row | undefined;
    if (!row) return undefined;
    return {
      sessionId: row.session_id as string,
      expiresAt: Number(row.expires_at),
      rotatedAt: row.rotated_at === null ? null : Number(row.rotated_at),
    };
  }

  markRefreshTokenRotated(tokenHash: string): boolean {
    const result = this.db
      .prepare('UPDATE refresh_tokens SET rotated_at = ? WHERE token_hash = ? AND rotated_at IS NULL')
      .run(this.now(), tokenHash);
    return Number(result.changes) === 1;
  }

  deleteToken(tokenHash: string): void {
    this.db.prepare('DELETE FROM access_tokens WHERE token_hash = ?').run(tokenHash);
    this.db.prepare('DELETE FROM refresh_tokens WHERE token_hash = ?').run(tokenHash);
  }

  close(): void {
    this.db.close();
  }

  sweep(): { codes: number; accessTokens: number; refreshTokens: number; sessions: number } {
    const now = this.now();
    const codes = this.db.prepare('DELETE FROM auth_codes WHERE expires_at <= ?').run(now).changes;
    const accessTokens = this.db.prepare('DELETE FROM access_tokens WHERE expires_at <= ?').run(now).changes;
    const refreshTokens = this.db.prepare('DELETE FROM refresh_tokens WHERE expires_at <= ?').run(now).changes;
    // A session with no refresh token left can never mint another access token.
    const sessions = this.db
      .prepare('DELETE FROM sessions WHERE created_at < ? AND session_id NOT IN (SELECT session_id FROM refresh_tokens)')
      .run(now - DAY_MS).changes;
    return { codes: Number(codes), accessTokens: Number(accessTokens), refreshTokens: Number(refreshTokens), sessions: Number(sessions) };
  }
}
