import { toIso, type Db } from '../db/db.ts';

export type Role = 'admin' | 'member';
export type UserStatus = 'invited' | 'active' | 'disabled';

export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  password_hash: string | null;
  invite_token_hash: string | null;
  invite_expires_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

/** The public user shape from contracts §9. */
export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  createdAt: string;
}

export function toUser(row: UserRow): User {
  return { id: row.id, email: row.email, name: row.name, role: row.role, status: row.status, createdAt: toIso(row.created_at) ?? '' };
}

export async function findUserById(db: Db, id: string): Promise<UserRow | undefined> {
  return (await db.query<UserRow>('select * from users where id = $1', [id])).rows[0];
}

export async function findUserByEmail(db: Db, email: string): Promise<UserRow | undefined> {
  return (await db.query<UserRow>('select * from users where email = $1', [email.toLowerCase()])).rows[0];
}

export const isUuid = (s: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
