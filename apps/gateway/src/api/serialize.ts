import type { User } from '../auth/users.ts';
import { toIso } from '../db/db.ts';
import { publicToolName } from '../upstream/naming.ts';
import { isToolAllowed } from '../upstream/policy.ts';
import type { ServerRecord } from '../upstream/registry.ts';

export interface ServerToolDto {
  name: string;
  publicName: string;
  title?: string;
  description?: string;
  allowedForMembers: boolean;
  annotations?: Record<string, unknown>;
}

/** Contracts §9 `Server`: never contains the secret; members get no `url` / auth header name. */
export function toServerDto(rec: ServerRecord, viewer: Pick<User, 'role'>): Record<string, unknown> {
  const admin = viewer.role === 'admin';
  const tools: ServerToolDto[] = [];
  for (const t of rec.tools) {
    const allowed = isToolAllowed(rec.memberToolPolicy, t.name);
    if (!admin && !allowed) continue;
    const dto: ServerToolDto = { name: t.name, publicName: publicToolName(rec.slug, t.name), allowedForMembers: allowed };
    if (t.title) dto.title = t.title;
    if (t.description) dto.description = t.description;
    if (t.annotations) dto.annotations = t.annotations as Record<string, unknown>;
    tools.push(dto);
  }
  const out: Record<string, unknown> = {
    id: rec.id,
    slug: rec.slug,
    name: rec.name,
    enabled: rec.enabled,
    authType: rec.authType,
    hasCredential: rec.hasCredential,
    timeoutMs: rec.timeoutMs,
    memberToolPolicy: rec.memberToolPolicy,
    managedBy: rec.managedBy,
    status: rec.status,
    tools,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
  if (admin) {
    out.url = rec.url;
    if (rec.authHeaderName) out.authHeaderName = rec.authHeaderName;
  }
  if (rec.statusError) out.statusError = rec.statusError;
  if (rec.statusCheckedAt) out.statusCheckedAt = rec.statusCheckedAt;
  if (rec.toolsUpdatedAt) out.toolsUpdatedAt = rec.toolsUpdatedAt;
  return out;
}

export interface ApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  created_at: Date | string;
  last_used_at: Date | string | null;
  revoked_at: Date | string | null;
}

export function toApiKeyDto(row: ApiKeyRow): Record<string, unknown> {
  const out: Record<string, unknown> = { id: row.id, userId: row.user_id, name: row.name, prefix: row.prefix, createdAt: toIso(row.created_at) };
  const lu = toIso(row.last_used_at);
  if (lu) out.lastUsedAt = lu;
  const rv = toIso(row.revoked_at);
  if (rv) out.revokedAt = rv;
  return out;
}
