import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireSession } from '../auth/middleware.ts';
import { isUuid } from '../auth/users.ts';
import { generateApiKey } from '../crypto/apikeys.ts';
import { newId } from '../crypto/random.ts';
import type { Db } from '../db/db.ts';
import { ApiError, notFound, parseBody, wrap } from './errors.ts';
import { toApiKeyDto, type ApiKeyRow } from './serialize.ts';

const keySchema = z.object({ name: z.string().trim().max(120).default('') });

export async function listKeysForUser(db: Db, userId: string): Promise<Record<string, unknown>[]> {
  const { rows } = await db.query<ApiKeyRow>('select * from api_keys where user_id = $1 order by created_at desc', [userId]);
  return rows.map(toApiKeyDto);
}

/** Creates a key; the plaintext is returned exactly once and never stored. */
export async function createKeyForUser(db: Db, userId: string, name: string, createdBy: string): Promise<{ key: Record<string, unknown>; plaintext: string }> {
  const gen = generateApiKey();
  const { rows } = await db.query<ApiKeyRow>(
    'insert into api_keys (id, user_id, name, prefix, key_hash, created_by) values ($1,$2,$3,$4,$5,$6) returning *',
    [newId(), userId, name, gen.prefix, gen.hash, createdBy],
  );
  const row = rows[0];
  if (!row) throw new ApiError(500, 'internal_error', 'insert failed');
  return { key: toApiKeyDto(row), plaintext: gen.plaintext };
}

export function keysRouter(db: Db): Router {
  const r = Router();
  r.use(requireSession);

  r.get(
    '/',
    wrap(async (req, res) => {
      res.json({ keys: await listKeysForUser(db, currentUser(req).id) });
    }),
  );

  r.post(
    '/',
    wrap(async (req, res) => {
      const me = currentUser(req);
      const { name } = parseBody(keySchema, req.body);
      res.status(201).json(await createKeyForUser(db, me.id, name, me.id));
    }),
  );

  r.delete(
    '/:id',
    wrap(async (req, res) => {
      const me = currentUser(req);
      const id = req.params.id as string;
      if (!isUuid(id)) throw notFound('API key');
      const { rows } = await db.query<ApiKeyRow>('select * from api_keys where id = $1', [id]);
      const row = rows[0];
      if (!row) throw notFound('API key');
      if (row.user_id !== me.id && me.role !== 'admin') throw new ApiError(403, 'forbidden', 'You may only revoke your own keys');
      await db.query('update api_keys set revoked_at = coalesce(revoked_at, now()) where id = $1', [id]);
      res.json({ ok: true });
    }),
  );

  return r;
}
