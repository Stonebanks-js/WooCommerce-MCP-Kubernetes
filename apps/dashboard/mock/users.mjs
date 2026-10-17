// /api/auth, /api/users, /api/keys and /api/audit handlers.
import { randomBytes } from 'node:crypto';
import { audit } from './audit.mjs';
import { invites, keys, newId, sessions, users } from './data.mjs';
import { fail, json, publicUser } from './http.mjs';

const now = () => new Date().toISOString();
const PUBLIC_URL = process.env.PUBLIC_URL ?? 'http://localhost:5173';
const COOKIE = 'gw_session';

function setSession(res, user) {
  const id = newId();
  sessions.set(id, user.id);
  res.setHeader('Set-Cookie', `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}`);
}

export async function login({ res, body }) {
  const email = String(body.email ?? '').trim().toLowerCase();
  const user = users.find((u) => u.email === email);
  if (!user || user.password !== body.password) return fail(res, 401, 'invalid_credentials', 'Email or password is incorrect');
  if (user.status === 'disabled') return fail(res, 403, 'disabled', 'This account is disabled');
  if (user.status === 'invited') return fail(res, 403, 'invited', 'Accept your invitation first');
  setSession(res, user);
  json(res, 200, { user: publicUser(user) });
}

export function logout({ res, sessionId }) {
  sessions.delete(sessionId);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  json(res, 200, { ok: true });
}

export function me({ res, user }) {
  json(res, 200, { user: publicUser(user) });
}

export function acceptInvite({ res, body }) {
  const userId = invites.get(String(body.token ?? ''));
  const user = userId && users.find((u) => u.id === userId);
  if (!user || user.status !== 'invited') return fail(res, 400, 'invalid_token', 'This invitation is invalid or has already been used');
  if (typeof body.password !== 'string' || body.password.length < 8) return fail(res, 400, 'validation', 'Password must be at least 8 characters');
  invites.delete(body.token);
  user.name = String(body.name ?? user.name);
  user.password = body.password;
  user.status = 'active';
  setSession(res, user);
  json(res, 200, { user: publicUser(user) });
}

export function listUsers({ res }) {
  json(res, 200, { users: users.map(publicUser) });
}

export function inviteUser({ res, body }) {
  const email = String(body.email ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(res, 400, 'validation', 'A valid email is required');
  if (users.some((u) => u.email === email)) return fail(res, 409, 'conflict', `${email} already has an account`);
  if (!['admin', 'member'].includes(body.role)) return fail(res, 400, 'validation', 'role must be admin or member');
  const user = { id: newId(), email, name: String(body.name ?? ''), role: body.role, status: 'invited', password: null, createdAt: now() };
  users.push(user);
  const token = randomBytes(32).toString('base64url');
  invites.set(token, user.id);
  json(res, 201, { user: publicUser(user), inviteUrl: `${PUBLIC_URL}/invite/${token}` });
}

export function patchUser({ res, user: actor, params, body }) {
  const user = users.find((u) => u.id === params.id);
  if (!user) return fail(res, 404, 'not_found', 'User not found');
  if (body.role !== undefined) {
    if (!['admin', 'member'].includes(body.role)) return fail(res, 400, 'validation', 'role must be admin or member');
    if (user.id === actor.id && body.role !== 'admin') return fail(res, 400, 'validation', 'You cannot demote yourself');
    user.role = body.role;
  }
  if (body.status !== undefined) {
    if (!['active', 'disabled'].includes(body.status)) return fail(res, 400, 'validation', 'status must be active or disabled');
    if (user.id === actor.id) return fail(res, 400, 'validation', 'You cannot change your own status');
    user.status = body.status;
  }
  if (body.name !== undefined) user.name = String(body.name);
  json(res, 200, { user: publicUser(user) });
}

export function deleteUser({ res, user: actor, params }) {
  if (params.id === actor.id) return fail(res, 400, 'validation', 'You cannot delete yourself');
  const i = users.findIndex((u) => u.id === params.id);
  if (i === -1) return fail(res, 404, 'not_found', 'User not found');
  users.splice(i, 1);
  for (let k = keys.length - 1; k >= 0; k--) if (keys[k].userId === params.id) keys.splice(k, 1);
  json(res, 200, { ok: true });
}

const keyView = ({ id, userId, name, prefix, createdAt, lastUsedAt, revokedAt }) => ({ id, userId, name, prefix, createdAt, lastUsedAt, revokedAt });

function issueKey(res, userId, name) {
  const prefix = `gw_${randomBytes(6).toString('base64url').replace(/[^a-z0-9]/gi, 'x').slice(0, 8).toLowerCase()}`;
  const key = { id: newId(), userId, name: String(name ?? ''), prefix, createdAt: now(), lastUsedAt: undefined, revokedAt: undefined };
  keys.unshift(key);
  json(res, 201, { key: keyView(key), plaintext: `${prefix}_${randomBytes(24).toString('base64url')}` });
}

export function listUserKeys({ res, params }) {
  if (!users.some((u) => u.id === params.id)) return fail(res, 404, 'not_found', 'User not found');
  json(res, 200, { keys: keys.filter((k) => k.userId === params.id).map(keyView) });
}
export function createUserKey({ res, params, body }) {
  if (!users.some((u) => u.id === params.id)) return fail(res, 404, 'not_found', 'User not found');
  issueKey(res, params.id, body.name);
}
export function listMyKeys({ res, user }) {
  json(res, 200, { keys: keys.filter((k) => k.userId === user.id).map(keyView) });
}
export function createMyKey({ res, user, body }) {
  issueKey(res, user.id, body.name);
}
export function revokeKey({ res, user, params }) {
  const key = keys.find((k) => k.id === params.id);
  if (!key || (key.userId !== user.id && user.role !== 'admin')) return fail(res, 404, 'not_found', 'Key not found');
  if (!key.revokedAt) key.revokedAt = now();
  json(res, 200, { ok: true });
}

export function listAudit({ res, user, query }) {
  const limit = Math.min(200, Math.max(1, Number(query.get('limit') ?? 50) || 50));
  const before = Number(query.get('before'));
  let rows = audit;
  if (user.role !== 'admin') rows = rows.filter((e) => e.userId === user.id);
  else if (query.get('userId')) rows = rows.filter((e) => e.userId === query.get('userId'));
  if (query.get('serverId')) rows = rows.filter((e) => e.serverId === query.get('serverId'));
  if (query.get('outcome')) rows = rows.filter((e) => e.outcome === query.get('outcome'));
  if (query.get('source')) rows = rows.filter((e) => e.source === query.get('source'));
  if (Number.isFinite(before) && before > 0) rows = rows.filter((e) => e.id < before);
  const entries = rows.slice(0, limit);
  const nextBefore = rows.length > limit ? entries[entries.length - 1].id : null;
  json(res, 200, { entries, nextBefore });
}
