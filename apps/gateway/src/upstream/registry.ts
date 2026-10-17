import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from '../config.ts';
import { decryptSecret } from '../crypto/secretbox.ts';
import type { Db } from '../db/db.ts';
import type { Logger } from '../log.ts';
import type { Metrics } from '../core/metrics.ts';
import { UpstreamConnection, type UpstreamCallResult } from './connection.ts';
import { normalizeTool, rowToRecord, type ServerRecord, type ServerRow, type ServerStatus, type ToolRoute } from './model.ts';
import { publicToolName } from './naming.ts';

export { normalizeTool, rowToRecord } from './model.ts';
export type { AuthType, ManagedBy, ServerRecord, ServerRow, ServerStatus, ToolRoute } from './model.ts';

/**
 * Loads `mcp_servers`, owns one `UpstreamConnection` per enabled server, runs the health loop
 * (probe + DB reload every HEALTH_INTERVAL_MS) and keeps the exact publicName → route map.
 */
export class UpstreamRegistry {
  private records = new Map<string, ServerRecord>();
  private connections = new Map<string, UpstreamConnection>();
  private routes = new Map<string, ToolRoute>();
  private timer: NodeJS.Timeout | null = null;
  private probing: Promise<void> | null = null;
  private readonly db: Db;
  private readonly config: Config;
  private readonly log: Logger;
  private readonly metrics: Metrics;

  constructor(db: Db, config: Config, log: Logger, metrics: Metrics) {
    this.db = db;
    this.config = config;
    this.log = log;
    this.metrics = metrics;
  }

  /** Load rows, probe every enabled server once (in parallel, isolated), then start the loop. */
  async start(): Promise<void> {
    await this.reload();
    await this.probeAll();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.healthIntervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.connections.values()].map((c) => c.close()));
    this.connections.clear();
  }

  private async tick(): Promise<void> {
    try {
      await this.reload();
      await this.probeAll();
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'health loop iteration failed');
    }
  }

  /** Re-reads all rows (other replicas / the provisioner may have changed them) and syncs connections. */
  async reload(): Promise<void> {
    const { rows } = await this.db.query<ServerRow>('select * from mcp_servers order by slug');
    const next = new Map<string, ServerRecord>();
    for (const row of rows) {
      const rec = rowToRecord(row);
      next.set(rec.id, rec);
      const existing = this.connections.get(rec.id);
      if (!rec.enabled) {
        if (existing) {
          this.connections.delete(rec.id);
          void existing.close();
        }
        continue;
      }
      const spec = this.buildSpec(row);
      if (existing && existing.sameAs(spec)) continue;
      if (existing) void existing.close();
      this.connections.set(rec.id, new UpstreamConnection(spec, this.connectionConfig(), this.log));
    }
    for (const [id, conn] of this.connections) {
      if (!next.has(id)) {
        this.connections.delete(id);
        void conn.close();
      }
    }
    this.records = next;
    this.rebuildRoutes();
    for (const rec of this.records.values()) this.metrics.upstreamUp.set({ server: rec.slug }, rec.enabled && rec.status === 'connected' ? 1 : 0);
  }

  private connectionConfig() {
    return {
      connectTimeoutMs: this.config.connectTimeoutMs,
      listToolsTimeoutMs: this.config.listToolsTimeoutMs,
      ssrf: { allowPrivate: this.config.allowPrivateUpstreams, allowedSuffixes: this.config.allowedInternalSuffixes },
      version: this.config.version,
    };
  }

  private buildSpec(row: ServerRow) {
    const headers: Record<string, string> = {};
    if (row.auth_type !== 'none' && row.auth_secret_enc) {
      let secret = '';
      try {
        secret = decryptSecret(row.auth_secret_enc, this.config.encryptionKey);
      } catch (err) {
        this.log.error({ server: row.slug, err: (err as Error).message }, 'cannot decrypt upstream credential');
      }
      if (secret) {
        if (row.auth_type === 'bearer') headers.Authorization = `Bearer ${secret}`;
        else headers[row.auth_header_name || 'X-Api-Key'] = secret;
      }
    }
    return { id: row.id, slug: row.slug, url: row.url, headers, timeoutMs: row.timeout_ms || this.config.defaultToolTimeoutMs };
  }

  private rebuildRoutes(): void {
    const routes = new Map<string, ToolRoute>();
    for (const rec of this.records.values()) {
      for (const tool of rec.tools) routes.set(publicToolName(rec.slug, tool.name), { serverId: rec.id, upstreamName: tool.name });
    }
    this.routes = routes;
  }

  /** Probes all enabled servers; one failure never affects another. */
  async probeAll(): Promise<void> {
    if (this.probing) return this.probing;
    this.probing = Promise.allSettled([...this.connections.keys()].map((id) => this.probe(id)))
      .then(() => undefined)
      .finally(() => {
        this.probing = null;
      });
    return this.probing;
  }

  /** Probe one server now and persist the result. Returns the fresh record (or undefined if unknown). */
  async probe(id: string): Promise<ServerRecord | undefined> {
    const rec = this.records.get(id);
    if (!rec) return undefined;
    const conn = this.connections.get(id);
    if (!rec.enabled || !conn) {
      await this.persistStatus(rec, 'disabled', null, null);
      return this.records.get(id);
    }
    const res = await conn.probe();
    if (res.ok) {
      await this.persistStatus(rec, 'connected', null, res.tools.map(normalizeTool));
    } else {
      this.log.warn({ server: rec.slug, reason: res.error }, 'upstream unreachable');
      await this.persistStatus(rec, 'unreachable', res.error, null);
    }
    return this.records.get(id);
  }

  private async persistStatus(snapshot: ServerRecord, status: ServerStatus, error: string | null, tools: Tool[] | null): Promise<void> {
    // A reload() or an admin edit may have replaced the record while the probe was in flight; never
    // write the pre-await snapshot back (it could resurrect enabled=true or an old policy).
    const rec = this.records.get(snapshot.id) ?? snapshot;
    if (!rec.enabled) status = 'disabled';
    const now = new Date();
    const updated: ServerRecord = { ...rec, status, statusCheckedAt: now.toISOString() };
    if (error) updated.statusError = error;
    else delete updated.statusError;
    if (tools) {
      updated.tools = tools;
      updated.toolsUpdatedAt = now.toISOString();
    }
    this.records.set(rec.id, updated);
    this.rebuildRoutes();
    this.metrics.upstreamUp.set({ server: rec.slug }, status === 'connected' ? 1 : 0);
    const dbStatus = rec.enabled ? status : 'disabled';
    try {
      if (tools) {
        await this.db.query(
          'update mcp_servers set status=$2, status_error=$3, status_checked_at=$4, tools_json=$5::jsonb, tools_updated_at=$4 where id=$1',
          [rec.id, dbStatus, error, now, JSON.stringify(tools)],
        );
      } else {
        await this.db.query('update mcp_servers set status=$2, status_error=$3, status_checked_at=$4 where id=$1', [rec.id, dbStatus, error, now]);
      }
    } catch (err) {
      this.log.warn({ server: rec.slug, err: (err as Error).message }, 'could not persist upstream status');
    }
  }

  /** Executes an upstream tool. Marks the server unreachable when the transport failed. */
  async callTool(serverId: string, upstreamName: string, args: Record<string, unknown>): Promise<UpstreamCallResult> {
    const rec = this.records.get(serverId);
    const conn = this.connections.get(serverId);
    if (!rec || !conn) {
      const slug = rec?.slug ?? serverId;
      return {
        outcome: 'unreachable',
        errorMessage: 'no connection',
        result: { content: [{ type: 'text', text: `Upstream "${slug}" is unreachable: no connection` }], isError: true },
      };
    }
    const res = await conn.callTool(upstreamName, args, rec.timeoutMs || this.config.defaultToolTimeoutMs);
    if (res.outcome === 'unreachable' && rec.status !== 'unreachable') {
      await this.persistStatus(rec, 'unreachable', res.errorMessage ?? 'unreachable', null);
    } else if (res.outcome !== 'unreachable' && rec.status !== 'connected' && rec.enabled) {
      await this.persistStatus(rec, 'connected', null, null);
    }
    return res;
  }

  snapshot(): ServerRecord[] {
    return [...this.records.values()];
  }

  get(id: string): ServerRecord | undefined {
    return this.records.get(id);
  }

  getBySlug(slug: string): ServerRecord | undefined {
    for (const r of this.records.values()) if (r.slug === slug) return r;
    return undefined;
  }

  route(publicName: string): ToolRoute | undefined {
    return this.routes.get(publicName);
  }
}
