import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { toIso } from '../db/db.ts';
import { parsePolicy, type MemberToolPolicy } from './policy.ts';

export type ServerStatus = 'connected' | 'unreachable' | 'disabled';
export type AuthType = 'none' | 'bearer' | 'header';
export type ManagedBy = 'admin' | 'seed' | 'provisioner';

/** One `mcp_servers` row as the driver returns it. */
export interface ServerRow {
  id: string;
  slug: string;
  name: string;
  url: string;
  enabled: boolean;
  auth_type: AuthType;
  auth_header_name: string | null;
  auth_secret_enc: string | null;
  timeout_ms: number;
  member_tool_policy: unknown;
  status: ServerStatus;
  status_error: string | null;
  status_checked_at: Date | string | null;
  tools_json: unknown;
  tools_updated_at: Date | string | null;
  managed_by: ManagedBy;
  created_at: Date | string;
  updated_at: Date | string;
}

/** In-memory view of one server (the secret stays encrypted in the row; it is never copied here). */
export interface ServerRecord {
  id: string;
  slug: string;
  name: string;
  url: string;
  enabled: boolean;
  authType: AuthType;
  authHeaderName?: string;
  hasCredential: boolean;
  timeoutMs: number;
  memberToolPolicy: MemberToolPolicy;
  managedBy: ManagedBy;
  status: ServerStatus;
  statusError?: string;
  statusCheckedAt?: string;
  toolsUpdatedAt?: string;
  tools: Tool[];
  createdAt: string;
  updatedAt: string;
}

export interface ToolRoute {
  serverId: string;
  upstreamName: string;
}

/** SDK clients reject tools whose inputSchema lacks `type: 'object'` or has non-object property values. */
export function normalizeTool(raw: Tool): Tool {
  const schema = (raw.inputSchema && typeof raw.inputSchema === 'object' ? { ...raw.inputSchema } : {}) as Record<string, unknown>;
  schema.type = 'object';
  if (schema.properties && typeof schema.properties === 'object') {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema.properties as Record<string, unknown>)) props[k] = v && typeof v === 'object' ? v : {};
    schema.properties = props;
  } else {
    delete schema.properties;
  }
  return { ...raw, inputSchema: schema as Tool['inputSchema'] };
}

export function rowToRecord(row: ServerRow): ServerRecord {
  const tools = Array.isArray(row.tools_json) ? (row.tools_json as Tool[]).map(normalizeTool) : [];
  const rec: ServerRecord = {
    id: row.id,
    slug: row.slug,
    name: row.name,
    url: row.url,
    enabled: row.enabled,
    authType: row.auth_type,
    hasCredential: !!row.auth_secret_enc,
    timeoutMs: row.timeout_ms,
    memberToolPolicy: parsePolicy(row.member_tool_policy),
    managedBy: row.managed_by,
    status: row.enabled ? row.status : 'disabled',
    tools,
    createdAt: toIso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: toIso(row.updated_at) ?? new Date(0).toISOString(),
  };
  if (row.auth_header_name) rec.authHeaderName = row.auth_header_name;
  if (row.status_error) rec.statusError = row.status_error;
  const checked = toIso(row.status_checked_at);
  if (checked) rec.statusCheckedAt = checked;
  const tu = toIso(row.tools_updated_at);
  if (tu) rec.toolsUpdatedAt = tu;
  return rec;
}
