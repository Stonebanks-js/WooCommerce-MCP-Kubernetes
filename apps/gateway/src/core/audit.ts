import { asNumber, toIso, type Db } from '../db/db.ts';

export type AuditOutcome = 'success' | 'error' | 'timeout' | 'unreachable' | 'denied' | 'not_found' | 'rate_limited';
export type AuditSource = 'mcp' | 'chat';

export interface AuditInput {
  userId?: string;
  userEmail: string;
  apiKeyId?: string;
  source: AuditSource;
  serverId?: string;
  serverSlug?: string;
  toolName?: string;
  publicToolName: string;
  durationMs: number;
  outcome: AuditOutcome;
  errorMessage?: string;
  args?: unknown;
  resultBytes?: number;
}

export interface AuditEntry {
  id: number;
  ts: string;
  userId?: string;
  userEmail: string;
  apiKeyId?: string;
  source: AuditSource;
  serverId?: string;
  serverSlug?: string;
  toolName?: string;
  publicToolName: string;
  durationMs: number;
  outcome: string;
  errorMessage?: string;
  argsPreview?: string;
  resultBytes?: number;
}

export const ARGS_PREVIEW_MAX = 2000;

export function argsPreview(args: unknown): string | undefined {
  if (args === undefined) return undefined;
  let s: string;
  try {
    s = JSON.stringify(args) ?? 'undefined';
  } catch {
    s = '[unserialisable]';
  }
  return s.length > ARGS_PREVIEW_MAX ? s.slice(0, ARGS_PREVIEW_MAX) : s;
}

export async function insertAudit(db: Db, a: AuditInput): Promise<void> {
  await db.query(
    `insert into audit_log (user_id, user_email, api_key_id, source, server_id, server_slug, tool_name, public_tool_name,
       duration_ms, outcome, error_message, args_preview, result_bytes)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      a.userId ?? null,
      a.userEmail,
      a.apiKeyId ?? null,
      a.source,
      a.serverId ?? null,
      a.serverSlug ?? null,
      a.toolName ?? null,
      a.publicToolName,
      Math.max(0, Math.round(a.durationMs)),
      a.outcome,
      a.errorMessage?.slice(0, 2000) ?? null,
      argsPreview(a.args) ?? null,
      a.resultBytes ?? null,
    ],
  );
}

export interface AuditQuery {
  limit: number;
  before?: number;
  userId?: string;
  serverId?: string;
  outcome?: string;
  source?: string;
}

interface AuditRow {
  id: number | string;
  ts: Date | string;
  user_id: string | null;
  user_email: string;
  api_key_id: string | null;
  source: AuditSource;
  server_id: string | null;
  server_slug: string | null;
  tool_name: string | null;
  public_tool_name: string;
  duration_ms: number;
  outcome: string;
  error_message: string | null;
  args_preview: string | null;
  result_bytes: number | null;
}

function rowToEntry(r: AuditRow): AuditEntry {
  const e: AuditEntry = {
    id: asNumber(r.id),
    ts: toIso(r.ts) ?? '',
    userEmail: r.user_email,
    source: r.source,
    publicToolName: r.public_tool_name,
    durationMs: r.duration_ms,
    outcome: r.outcome,
  };
  if (r.user_id) e.userId = r.user_id;
  if (r.api_key_id) e.apiKeyId = r.api_key_id;
  if (r.server_id) e.serverId = r.server_id;
  if (r.server_slug) e.serverSlug = r.server_slug;
  if (r.tool_name) e.toolName = r.tool_name;
  if (r.error_message) e.errorMessage = r.error_message;
  if (r.args_preview != null) e.argsPreview = r.args_preview;
  if (r.result_bytes != null) e.resultBytes = r.result_bytes;
  return e;
}

export async function queryAudit(db: Db, q: AuditQuery): Promise<{ entries: AuditEntry[]; nextBefore: number | null }> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (q.before !== undefined) add('id < ?', q.before);
  if (q.userId) add('user_id = ?', q.userId);
  if (q.serverId) add('server_id = ?', q.serverId);
  if (q.outcome) add('outcome = ?', q.outcome);
  if (q.source) add('source = ?', q.source);
  params.push(q.limit);
  const sql = `select * from audit_log ${where.length ? `where ${where.join(' and ')}` : ''} order by id desc limit $${params.length}`;
  const { rows } = await db.query<AuditRow>(sql, params);
  const entries = rows.map(rowToEntry);
  const last = entries[entries.length - 1];
  return { entries, nextBefore: entries.length === q.limit && last ? last.id : null };
}
