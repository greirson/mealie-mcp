import { createHash } from 'node:crypto';
import { safeEqual } from '../store/crypto.js';

const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!VERIFIER_PATTERN.test(verifier)) return false;
  return safeEqual(createHash('sha256').update(verifier).digest('base64url'), challenge);
}
