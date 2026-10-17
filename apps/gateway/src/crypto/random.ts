import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const newId = (): string => randomUUID();

/** URL-safe random token (base64url, no padding). */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export const sha256Hex = (input: string): string => createHash('sha256').update(input).digest('hex');

const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Random lower-case alphanumeric string (unbiased: rejection sampling over 36 symbols). */
export function randomAlnum(length: number): string {
  let out = '';
  while (out.length < length) {
    for (const b of randomBytes(length)) {
      if (b < 252) out += ALNUM[b % 36];
      if (out.length === length) break;
    }
  }
  return out;
}
