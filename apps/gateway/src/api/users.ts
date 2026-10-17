import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireAdmin } from '../auth/middleware.ts';
import { findUserByEmail, findUserById, isUuid, toUser, type UserRow } from '../auth/users.ts';
import type { Config } from '../config.ts';
import { newId, randomToken, sha256Hex } from '../crypto/random.ts';
import type { Db } from '../db/db.ts';
import { ApiError, notFound, parseBody, wrap } from './errors.ts';
import { createKeyForUser, listKeysForUser } from './keys.ts';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const inviteSchema = z.object({
  email: z.string().email().max(320),
  name: z.string().trim().max(120).optional(),
  role: z.enum(['admin', 'member']),
});
const patchSchema = z.object({
  role: z.enum(['admin', 'member']).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  name: z.string().trim().max(120).optional(),
});
const keySchema = z.object({ name: z.string().trim().max(120).default('') });

export function inviteUrl(publicUrl: string, token: string): string {
  return `${publicUrl}/invite/${encodeURIComponent(token)}`;
}

export function usersRouter(db: Db, config: Config): Router {
  const r = Router();
  r.use(requireAdmin);

  async function lookup(id: string): Promise<UserRow> {
    if (!isUuid(id)) throw notFound('User');
    const row = await findUserById(db, id);
    if (!row) throw notFound('User');
    return row;
  }

  r.get(
    '/',
    wrap(async (_req, res) => {
      const { rows } = await db.query<UserRow>('select * from users order by created_at asc, email asc');
      res.json({ users: rows.map(toUser) });
    }),
  );

  r.post(
    '/invite',
    wrap(async (req, res) => {
      const input = parseBody(inviteSchema, req.body);
      const email = input.email.toLowerCase();
      if (await findUserByEmail(db, email)) throw new ApiError(409, 'email_exists', `A user with email ${email} already exists`);
      const token = randomToken(32);
      const id = newId();
      const { rows } = await db.query<UserRow>(
        `insert into users (id, email, name, role, status, invite_token_hash, invite_expires_at)
         values ($1,$2,$3,$4,'invited',$5,$6) returning *`,
        [id, email, input.name ?? '', input.role, sha256Hex(token), new Date(Date.now() + INVITE_TTL_MS)],
      );
      const row = rows[0];
      if (!row) throw new ApiError(500, 'internal_error', 'insert failed');
      res.status(201).json({ user: toUser(row), inviteUrl: inviteUrl(config.publicUrl, token) });
    }),
  );

  r.patch(
    '/:id',
    wrap(async (req, res) => {
      const row = await lookup(req.params.id as string);
      const input = parseBody(patchSchema, req.body);
      const me = currentUser(req);
      if (row.id === me.id && (input.role !== undefined || input.status !== undefined)) {
        throw new ApiError(400, 'cannot_modify_self', 'You cannot change your own role or status');
      }
      if (input.status !== undefined && row.status === 'invited' && input.status === 'active') {
        throw new ApiError(400, 'invite_pending', 'Invited users become active by accepting their invite');
      }
      const sets: string[] = ['updated_at = now()'];
      const params: unknown[] = [row.id];
      const set = (col: string, v: unknown) => {
        params.push(v);
        sets.push(`${col} = $${params.length}`);
      };
      if (input.role !== undefined) set('role', input.role);
      if (input.status !== undefined) set('status', input.status);
      if (input.name !== undefined) set('name', input.name);
      const { rows } = await db.query<UserRow>(`update users set ${sets.join(', ')} where id = $1 returning *`, params);
      const updated = rows[0];
      if (!updated) throw notFound('User');
      if (input.status === 'disabled') await db.query('delete from sessions where user_id = $1', [row.id]);
      res.json({ user: toUser(updated) });
    }),
  );

  r.delete(
    '/:id',
    wrap(async (req, res) => {
      const row = await lookup(req.params.id as string);
      if (row.id === currentUser(req).id) throw new ApiError(400, 'cannot_delete_self', 'You cannot delete your own account');
      await db.query('delete from users where id = $1', [row.id]);
      res.json({ ok: true });
    }),
  );

  r.get(
    '/:id/keys',
    wrap(async (req, res) => {
      const row = await lookup(req.params.id as string);
      res.json({ keys: await listKeysForUser(db, row.id) });
    }),
  );

  r.post(
    '/:id/keys',
    wrap(async (req, res) => {
      const row = await lookup(req.params.id as string);
      const { name } = parseBody(keySchema, req.body);
      res.status(201).json(await createKeyForUser(db, row.id, name, currentUser(req).id));
    }),
  );

  return r;
}
