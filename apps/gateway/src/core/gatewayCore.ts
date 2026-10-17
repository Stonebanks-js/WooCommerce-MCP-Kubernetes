import { ErrorCode, McpError, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { User } from '../auth/users.ts';
import type { Db } from '../db/db.ts';
import type { Logger } from '../log.ts';
import { describeWithSource, publicToolName } from '../upstream/naming.ts';
import { isToolAllowed } from '../upstream/policy.ts';
import type { ServerRecord, UpstreamRegistry } from '../upstream/registry.ts';
import { insertAudit, type AuditInput, type AuditOutcome, type AuditSource } from './audit.ts';
import type { Metrics } from './metrics.ts';
import type { RateLimiter } from './ratelimit.ts';

/** Contracts §9 `PublicTool`: exactly what a user sees over MCP. */
export interface PublicTool {
  publicName: string;
  serverSlug: string;
  serverName: string;
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface CallContext {
  source: AuditSource;
  apiKeyId?: string;
}

export interface CoreCallResult {
  result: CallToolResult;
  outcome: AuditOutcome;
  durationMs: number;
  serverSlug: string;
  toolName: string;
}

/** Rate-limit / permission failures surface to MCP as JSON-RPC errors; this carries the audit outcome too. */
export class ToolCallRejected extends McpError {
  readonly outcome: AuditOutcome;

  constructor(code: number, message: string, outcome: AuditOutcome) {
    super(code, message);
    // McpError prefixes its message with "MCP error <code>: "; clients add the same prefix again when
    // they surface JSON-RPC errors, so keep the wire message clean.
    this.message = message;
    this.outcome = outcome;
  }
}

export const RATE_LIMIT_CODE = -32000;

export function serverVisible(rec: ServerRecord): boolean {
  return rec.enabled;
}

export function toolVisibleFor(user: Pick<User, 'role'>, rec: ServerRecord, tool: Tool): boolean {
  return user.role === 'admin' || isToolAllowed(rec.memberToolPolicy, tool.name);
}

export function toPublicTool(rec: ServerRecord, tool: Tool): PublicTool {
  const pt: PublicTool = {
    publicName: publicToolName(rec.slug, tool.name),
    serverSlug: rec.slug,
    serverName: rec.name,
    name: tool.name,
    description: describeWithSource(rec.name, tool.description),
    inputSchema: tool.inputSchema as Record<string, unknown>,
  };
  if (tool.title) pt.title = tool.title;
  if (tool.annotations) pt.annotations = tool.annotations as Record<string, unknown>;
  return pt;
}

/** Converts a PublicTool back into the MCP `Tool` shape served by `tools/list`. */
export function toMcpTool(pt: PublicTool): Tool {
  const t: Tool = { name: pt.publicName, inputSchema: pt.inputSchema as Tool['inputSchema'] };
  if (pt.title) t.title = pt.title;
  if (pt.description) t.description = pt.description;
  if (pt.annotations) t.annotations = pt.annotations as Tool['annotations'];
  return t;
}

export interface CoreDeps {
  db: Db;
  registry: UpstreamRegistry;
  metrics: Metrics;
  rateLimiter: RateLimiter;
  log: Logger;
}

/**
 * The ONLY path that executes upstream tools. Both the MCP endpoint and the chat agent call
 * `callTool`, so permission checks, rate limiting, metrics and the audit row are identical.
 */
export class GatewayCore {
  private readonly deps: CoreDeps;

  constructor(deps: CoreDeps) {
    this.deps = deps;
  }

  listToolsFor(user: Pick<User, 'role'>): PublicTool[] {
    const out: PublicTool[] = [];
    for (const rec of this.deps.registry.snapshot()) {
      if (!serverVisible(rec)) continue;
      for (const tool of rec.tools) if (toolVisibleFor(user, rec, tool)) out.push(toPublicTool(rec, tool));
    }
    return out.sort((a, b) => a.publicName.localeCompare(b.publicName));
  }

  /**
   * Resolves, authorises, rate-limits and executes one tool call, writing exactly one audit row.
   * Throws `ToolCallRejected` (a `McpError`) for not_found / denied / rate_limited; every other
   * outcome is returned as a `CallToolResult` (with `isError` for failures).
   */
  async callTool(user: User, publicName: string, args: unknown, ctx: CallContext): Promise<CoreCallResult> {
    const { registry } = this.deps;
    const started = performance.now();
    const base: AuditInput = {
      userId: user.id,
      userEmail: user.email,
      source: ctx.source,
      publicToolName: publicName,
      durationMs: 0,
      outcome: 'not_found',
      args,
    };
    if (ctx.apiKeyId) base.apiKeyId = ctx.apiKeyId;
    const argObj = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};

    const route = registry.route(publicName);
    const rec = route ? registry.get(route.serverId) : undefined;
    if (!route || !rec) {
      throw await this.reject(base, started, new ToolCallRejected(ErrorCode.InvalidParams, `Unknown tool: ${publicName}`, 'not_found'));
    }
    base.serverId = rec.id;
    base.serverSlug = rec.slug;
    base.toolName = route.upstreamName;
    if (!rec.enabled) {
      throw await this.reject(base, started, new ToolCallRejected(ErrorCode.InvalidParams, `Server ${rec.slug} is disabled`, 'denied'));
    }
    if (user.role !== 'admin' && !isToolAllowed(rec.memberToolPolicy, route.upstreamName)) {
      throw await this.reject(base, started, new ToolCallRejected(ErrorCode.InvalidParams, 'Tool not permitted for your role', 'denied'));
    }
    const rateKey = ctx.apiKeyId ? `key:${ctx.apiKeyId}` : `user:${user.id}`;
    if (!this.deps.rateLimiter.take(rateKey)) {
      throw await this.reject(base, started, new ToolCallRejected(RATE_LIMIT_CODE, 'Rate limit exceeded', 'rate_limited'));
    }

    const upstream = await registry.callTool(rec.id, route.upstreamName, argObj);
    const durationMs = performance.now() - started;
    const resultBytes = Buffer.byteLength(JSON.stringify(upstream.result.content ?? []) + (upstream.result.structuredContent ? JSON.stringify(upstream.result.structuredContent) : ''));
    const audit: AuditInput = { ...base, durationMs, outcome: upstream.outcome, resultBytes };
    if (upstream.errorMessage) audit.errorMessage = upstream.errorMessage;
    await this.record(audit, rec.slug, route.upstreamName, durationMs);
    return { result: upstream.result, outcome: upstream.outcome, durationMs, serverSlug: rec.slug, toolName: route.upstreamName };
  }

  private async reject(base: AuditInput, started: number, err: ToolCallRejected): Promise<ToolCallRejected> {
    const durationMs = performance.now() - started;
    await this.record({ ...base, durationMs, outcome: err.outcome, errorMessage: err.message }, base.serverSlug ?? '', base.toolName ?? '', durationMs);
    return err;
  }

  private async record(a: AuditInput, server: string, tool: string, durationMs: number): Promise<void> {
    const { metrics, db, log } = this.deps;
    metrics.toolCalls.inc({ server, tool, outcome: a.outcome, source: a.source });
    if (a.outcome === 'success' || a.outcome === 'error' || a.outcome === 'timeout') metrics.toolDuration.observe({ server, tool }, durationMs / 1000);
    try {
      await insertAudit(db, a);
    } catch (err) {
      log.error({ err: (err as Error).message, tool: a.publicToolName }, 'audit row could not be written');
    }
    log.info(
      { user: a.userEmail, source: a.source, tool: a.publicToolName, outcome: a.outcome, durationMs: Math.round(durationMs), ...(a.errorMessage ? { error: a.errorMessage } : {}) },
      'tool call',
    );
  }
}
