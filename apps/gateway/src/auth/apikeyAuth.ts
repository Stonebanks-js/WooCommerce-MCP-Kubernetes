import type { Request } from 'express';
import { hashApiKey, hashesEqual, parseApiKey } from '../crypto/apikeys.ts';
import type { Db } from '../db/db.ts';
import { toUser, type User, type UserRow } from './users.ts';

export interface ApiKeyAuth {
  user: User;
  apiKeyId: string;
}

export type ApiKeyAuthResult = { ok: true; auth: ApiKeyAuth } | { ok: false; reason: string };

interface KeyRow {
  id: string;
  key_hash: string;
  revoked_at: Date | string | null;
}

/** Extracts the key from `Authorization: Bearer` or `X-Api-Key`. Query strings are never consulted. */
export function extractApiKey(req: Pick<Request, 'headers'>): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m?.[1]) return m[1].trim();
  }
  const x = req.headers['x-api-key'];
  if (typeof x === 'string' && x.trim()) return x.trim();
  return undefined;
}

const lastUsedWritten = new Map<string, number>();
const LAST_USED_INTERVAL_MS = 60_000;

/** Looks the key up by prefix, compares hashes in constant time, and checks key + user state. */
export async function authenticateApiKey(db: Db, plaintext: string | undefined): Promise<ApiKeyAuthResult> {
  if (!plaintext) return { ok: false, reason: 'Missing API key: send Authorization: Bearer <key> or X-Api-Key' };
  const parsed = parseApiKey(plaintext);
  if (!parsed) return { ok: false, reason: 'Malformed API key' };
  const hash = hashApiKey(plaintext);
  const { rows } = await db.query<KeyRow & { user: UserRow }>(
    `select k.id, k.key_hash, k.revoked_at, row_to_json(u.*) as user
       from api_keys k join users u on u.id = k.user_id where k.prefix = $1`,
    [parsed.prefix],
  );
  const match = rows.find((r) => hashesEqual(r.key_hash, hash));
  if (!match) return { ok: false, reason: 'Unknown API key' };
  if (match.revoked_at) return { ok: false, reason: 'API key has been revoked' };
  const userRow = match.user;
  if (userRow.status !== 'active') return { ok: false, reason: `User account is ${userRow.status}` };
  const now = Date.now();
  const last = lastUsedWritten.get(match.id) ?? 0;
  if (now - last > LAST_USED_INTERVAL_MS) {
    lastUsedWritten.set(match.id, now);
    db.query('update api_keys set last_used_at = now() where id = $1', [match.id]).catch(() => undefined);
  }
  return { ok: true, auth: { user: toUser(userRow), apiKeyId: match.id } };
}
