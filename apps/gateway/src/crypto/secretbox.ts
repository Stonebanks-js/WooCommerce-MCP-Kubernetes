import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Parses `GATEWAY_ENCRYPTION_KEY` (base64 of 32 random bytes). */
export function parseEncryptionKey(b64: string): Buffer {
  const key = Buffer.from(b64.trim(), 'base64');
  if (key.length !== 32) throw new Error('GATEWAY_ENCRYPTION_KEY must be base64 of exactly 32 bytes');
  return key;
}

/** AES-256-GCM. Output format: `v1:<iv b64>:<ct b64>:<tag b64>`. */
export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${ct.toString('base64')}:${tag.toString('base64')}`;
}

/** Throws on a malformed string, a wrong key, or any tampering (GCM tag check). */
export function decryptSecret(encoded: string, key: Buffer): string {
  const parts = encoded.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('unsupported secret format');
  const iv = Buffer.from(parts[1] ?? '', 'base64');
  const ct = Buffer.from(parts[2] ?? '', 'base64');
  const tag = Buffer.from(parts[3] ?? '', 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('malformed secret');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
