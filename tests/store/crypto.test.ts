import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, hashToken, randomToken, safeEqual } from '../../src/store/crypto.js';

const key = Buffer.alloc(32, 3);

describe('crypto', () => {
  it('round-trips plaintext', () => {
    const blob = encrypt(key, 'mealie-token-abc');
    expect(blob.startsWith('v1.')).toBe(true);
    expect(blob).not.toContain('mealie-token-abc');
    expect(decrypt(key, blob)).toBe('mealie-token-abc');
  });

  it('uses a fresh IV each time', () => {
    expect(encrypt(key, 'same')).not.toBe(encrypt(key, 'same'));
  });

  it('fails with the wrong key', () => {
    const blob = encrypt(key, 'secret');
    expect(() => decrypt(Buffer.alloc(32, 4), blob)).toThrow();
  });

  it('fails on tampered ciphertext', () => {
    const [v, iv, ct, tag] = encrypt(key, 'secret').split('.');
    const flipped = Buffer.from(ct!, 'base64url');
    flipped[0] = flipped[0]! ^ 0xff;
    expect(() => decrypt(key, [v, iv, flipped.toString('base64url'), tag].join('.'))).toThrow();
  });

  it('rejects unknown formats', () => {
    expect(() => decrypt(key, 'garbage')).toThrow(/format/);
  });

  it('rejects a truncated auth tag instead of accepting it as a shorter valid tag', () => {
    const [v, iv, ct, tag] = encrypt(key, 'secret').split('.');
    const shortTag = Buffer.from(tag!, 'base64url').subarray(0, 4).toString('base64url');
    expect(() => decrypt(key, [v, iv, ct, shortTag].join('.'))).toThrow(/format/);
  });

  it('rejects a truncated IV', () => {
    const [v, iv, ct, tag] = encrypt(key, 'secret').split('.');
    const shortIv = Buffer.from(iv!, 'base64url').subarray(0, 4).toString('base64url');
    expect(() => decrypt(key, [v, shortIv, ct, tag].join('.'))).toThrow(/format/);
  });

  it('hashes deterministically and generates random tokens', () => {
    expect(hashToken('a')).toBe(hashToken('a'));
    expect(hashToken('a')).toMatch(/^[0-9a-f]{64}$/);
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(t);
  });

  it('compares strings in constant time', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
