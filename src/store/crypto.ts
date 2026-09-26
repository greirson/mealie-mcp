import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';

export function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), ciphertext.toString('base64url'), tag.toString('base64url')].join('.');
}

export function decrypt(key: Buffer, blob: string): string {
  const [version, iv, ciphertext, tag] = blob.split('.');
  if (version !== VERSION || !iv || !ciphertext || !tag) throw new Error('Unrecognized ciphertext format');
  const ivBuf = Buffer.from(iv, 'base64url');
  const tagBuf = Buffer.from(tag, 'base64url');
  // node:24 accepts a truncated auth tag unless the expected length is pinned, which would let a
  // shortened tag be checked against fewer bytes than GCM's 16-byte tag guarantees.
  if (ivBuf.length !== 12) throw new Error('Unrecognized ciphertext format');
  if (tagBuf.length !== 16) throw new Error('Unrecognized ciphertext format');
  const decipher = createDecipheriv('aes-256-gcm', key, ivBuf, { authTagLength: 16 });
  decipher.setAuthTag(tagBuf);
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
