import { Router } from 'express';
import { z } from 'zod';
import { clearSessionCookie, createSession, deleteSession, setSessionCookie } from '../auth/sessions.ts';
import { findUserByEmail, toUser, type UserRow } from '../auth/users.ts';
import { requireSession } from '../auth/middleware.ts';
import { hashPassword, verifyPassword } from '../crypto/password.ts';
import { sha256Hex } from '../crypto/random.ts';
import type { Db } from '../db/db.ts';
import { ApiError, parseBody, wrap } from './errors.ts';

const loginSchema = z.object({ email: z.string().email().max(320), password: z.string().min(1).max(1024) });
const acceptSchema = z.object({ token: z.string().min(16).max(256), name: z.string().trim().max(120).default(''), password: z.string().min(8).max(1024) });

export function authRouter(db: Db, cookieSecure: boolean): Router {
  const r = Router();

  r.post(
    '/login',
    wrap(async (req, res) => {
      const { email, password } = parseBody(loginSchema, req.body);
      const row = await findUserByEmail(db, email);
      const ok = row ? await verifyPassword(password, row.password_hash) : await verifyPassword(password, null);
      if (!row || !ok || row.status !== 'active') throw new ApiError(401, 'invalid_credentials', 'Invalid email or password');
      const sid = await createSession(db, row.id);
      setSessionCookie(res, sid, cookieSecure);
      res.json({ user: toUser(row) });
    }),
  );

  r.post(
    '/logout',
    requireSession,
    wrap(async (req, res) => {
      if (req.sessionId) await deleteSession(db, req.sessionId);
      clearSessionCookie(res, cookieSecure);
      res.json({ ok: true });
    }),
  );

  r.get('/me', requireSession, (req, res) => {
    res.json({ user: req.sessionUser });
  });

  r.post(
    '/accept-invite',
    wrap(async (req, res) => {
      const { token, name, password } = parseBody(acceptSchema, req.body);
      const { rows } = await db.query<UserRow>('select * from users where invite_token_hash = $1', [sha256Hex(token)]);
      const row = rows[0];
      if (!row || row.status !== 'invited') throw new ApiError(400, 'invalid_invite', 'Invite token is invalid or already used');
      if (!row.invite_expires_at || new Date(row.invite_expires_at).getTime() < Date.now()) throw new ApiError(400, 'invite_expired', 'Invite token has expired');
      const hash = await hashPassword(password);
      const updated = await db.query<UserRow>(
        `update users set name = $2, password_hash = $3, status = 'active', invite_token_hash = null, invite_expires_at = null, updated_at = now()
         where id = $1 and status = 'invited' returning *`,
        [row.id, name || row.name, hash],
      );
      const u = updated.rows[0];
      if (!u) throw new ApiError(400, 'invalid_invite', 'Invite token is invalid or already used');
      const sid = await createSession(db, u.id);
      setSessionCookie(res, sid, cookieSecure);
      res.json({ user: toUser(u) });
    }),
  );

  return r;
}
