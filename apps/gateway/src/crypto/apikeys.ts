import { timingSafeEqual } from 'node:crypto';
import { randomAlnum, randomToken, sha256Hex } from './random.ts';

export interface GeneratedApiKey {
  plaintext: string;
  prefix: string;
  hash: string;
}

const KEY_RE = /^(gw_[a-z0-9]{8})_[A-Za-z0-9_-]{32}$/;

/** `gw_` + 8 chars `[a-z0-9]` (prefix) + `_` + 32 chars base64url. Only `sha256(fullKey)` is stored. */
export function generateApiKey(): GeneratedApiKey {
  const prefix = `gw_${randomAlnum(8)}`;
  const plaintext = `${prefix}_${randomToken(24)}`; // 24 random bytes -> exactly 32 base64url chars
  return { plaintext, prefix, hash: sha256Hex(plaintext) };
}

export const hashApiKey = (plaintext: string): string => sha256Hex(plaintext);

/** Returns the prefix of a well-formed key, or null. */
export function parseApiKey(plaintext: string): { prefix: string } | null {
  const m = KEY_RE.exec(plaintext);
  return m?.[1] ? { prefix: m[1] } : null;
}

/** Constant-time comparison of two hex digests. */
export function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length > 0 && ba.length === bb.length && timingSafeEqual(ba, bb);
}
