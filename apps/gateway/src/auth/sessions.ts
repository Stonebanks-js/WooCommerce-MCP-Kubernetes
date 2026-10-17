import type { Response } from 'express';
import { newId } from '../crypto/random.ts';
import type { Db } from '../db/db.ts';
import type { UserRow } from './users.ts';

export const SESSION_COOKIE = 'gw_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function createSession(db: Db, userId: string): Promise<string> {
  const id = newId();
  await db.query('insert into sessions (id, user_id, expires_at) values ($1, $2, $3)', [id, userId, new Date(Date.now() + SESSION_TTL_MS)]);
  return id;
}

/** Returns the user for a live session id, or undefined (expired sessions are deleted lazily). */
export async function findSessionUser(db: Db, sessionId: string): Promise<UserRow | undefined> {
  const { rows } = await db.query<UserRow & { expires_at: Date | string }>(
    'select u.*, s.expires_at from sessions s join users u on u.id = s.user_id where s.id = $1',
    [sessionId],
  );
  const row = rows[0];
  if (!row) return undefined;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await db.query('delete from sessions where id = $1', [sessionId]);
    return undefined;
  }
  return row;
}

export async function deleteSession(db: Db, sessionId: string): Promise<void> {
  await db.query('delete from sessions where id = $1', [sessionId]);
}

export function setSessionCookie(res: Response, sessionId: string, secure: boolean): void {
  res.cookie(SESSION_COOKIE, sessionId, { httpOnly: true, sameSite: 'lax', path: '/', secure, maxAge: SESSION_TTL_MS });
}

export function clearSessionCookie(res: Response, secure: boolean): void {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', path: '/', secure });
}
