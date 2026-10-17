import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from '../log.ts';
import { validateUpstreamUrl, type SsrfOptions } from './ssrf.ts';

export type CallOutcome = 'success' | 'error' | 'timeout' | 'unreachable';

export interface UpstreamCallResult {
  outcome: CallOutcome;
  result: CallToolResult;
  errorMessage?: string;
}

export interface UpstreamSpec {
  id: string;
  slug: string;
  url: string;
  /** Already-decrypted credential headers (never logged). */
  headers: Record<string, string>;
  timeoutMs: number;
}

export interface ConnectionConfig {
  connectTimeoutMs: number;
  listToolsTimeoutMs: number;
  ssrf: SsrfOptions;
  version: string;
}

export type ProbeResult = { ok: true; tools: Tool[] } | { ok: false; error: string };

/** Error thrown by the connection layer when the upstream cannot be reached at all. */
export class UpstreamUnreachableError extends Error {
  override readonly name = 'UpstreamUnreachableError';
}

/** Turns any thrown value into a short, human readable reason (no secrets, no stack). */
export function describeTransportError(err: unknown): string {
  if (err instanceof StreamableHTTPError) return err.code ? `HTTP ${err.code} from upstream` : 'HTTP error from upstream';
  if (err instanceof McpError) {
    if (err.code === ErrorCode.RequestTimeout) {
      const t = (err.data as { timeout?: number } | undefined)?.timeout;
      return t ? `timeout after ${t} ms` : 'request timed out';
    }
    return err.message.replace(/^MCP error -?\d+: /, '');
  }
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    if (cause && typeof cause === 'object') {
      const c = cause as { code?: string; address?: string; port?: number; message?: string };
      if (c.code) return [c.code === 'ECONNREFUSED' ? 'connect ECONNREFUSED' : c.code, c.address && c.port ? `${c.address}:${c.port}` : c.address].filter(Boolean).join(' ');
      if (c.message) return c.message;
    }
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return 'request aborted (hard timeout)';
    return err.message || err.name;
  }
  return String(err);
}

function isTimeout(err: unknown): boolean {
  return err instanceof McpError && err.code === ErrorCode.RequestTimeout;
}

/** JSON-RPC errors that mean "the tool itself failed" rather than "the server is gone". */
function isToolLevelError(err: unknown): boolean {
  return (
    err instanceof McpError &&
    (err.code === ErrorCode.InvalidParams || err.code === ErrorCode.MethodNotFound || err.code === ErrorCode.InternalError || err.code === ErrorCode.InvalidRequest)
  );
}

const textResult = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });

/**
 * One upstream MCP server: a lazily created SDK `Client` over Streamable HTTP with the decrypted
 * credential. All failures are mapped to outcomes; a transport failure drops the client so the
 * next call reconnects from scratch.
 */
export class UpstreamConnection {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private readonly hardTimeoutMs: number;
  readonly spec: UpstreamSpec;
  private readonly cfg: ConnectionConfig;
  private readonly log: Logger;

  constructor(spec: UpstreamSpec, cfg: ConnectionConfig, log: Logger) {
    this.spec = spec;
    this.cfg = cfg;
    this.log = log;
    this.hardTimeoutMs = Math.max(spec.timeoutMs, cfg.listToolsTimeoutMs, cfg.connectTimeoutMs) + 1000;
  }

  /** Same server, same URL/credential/timeout → the live client can be kept. */
  sameAs(other: UpstreamSpec): boolean {
    const a = this.spec;
    return (
      a.url === other.url &&
      a.timeoutMs === other.timeoutMs &&
      JSON.stringify(a.headers) === JSON.stringify(other.headers)
    );
  }

  /** connect + initialize + tools/list, each with its own timeout. Never throws. */
  async probe(): Promise<ProbeResult> {
    try {
      const client = await this.ensure();
      const res = await client.listTools(undefined, { timeout: this.cfg.listToolsTimeoutMs });
      return { ok: true, tools: res.tools };
    } catch (err) {
      await this.drop();
      return { ok: false, error: describeTransportError(err) };
    }
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs = this.spec.timeoutMs): Promise<UpstreamCallResult> {
    let client: Client;
    try {
      client = await this.ensure();
    } catch (err) {
      await this.drop();
      const reason = describeTransportError(err);
      return { outcome: 'unreachable', errorMessage: reason, result: textResult(`Upstream "${this.spec.slug}" is unreachable: ${reason}`) };
    }
    try {
      const result = (await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs })) as CallToolResult;
      if (result.isError) {
        return { outcome: 'error', result, errorMessage: firstText(result) };
      }
      return { outcome: 'success', result };
    } catch (err) {
      if (isTimeout(err)) {
        return { outcome: 'timeout', errorMessage: `timeout after ${timeoutMs} ms`, result: textResult(`Upstream "${this.spec.slug}" timed out after ${timeoutMs} ms`) };
      }
      if (isToolLevelError(err)) {
        const msg = describeTransportError(err);
        return { outcome: 'error', errorMessage: msg, result: textResult(msg) };
      }
      await this.drop();
      const reason = describeTransportError(err);
      return { outcome: 'unreachable', errorMessage: reason, result: textResult(`Upstream "${this.spec.slug}" is unreachable: ${reason}`) };
    }
  }

  /** Drops the live client (if any); the next call reconnects. */
  async drop(): Promise<void> {
    const c = this.client;
    this.client = null;
    this.connecting = null;
    if (c) await c.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.drop();
  }

  get connected(): boolean {
    return this.client !== null;
  }

  private ensure(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    if (this.connecting) return this.connecting;
    this.connecting = this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connect(): Promise<Client> {
    // Validated on create/update and again here, in case DNS now points somewhere it should not.
    const url = await validateUpstreamUrl(this.spec.url, this.cfg.ssrf);
    const client = new Client({ name: 'urumi-mcp-gateway', version: this.cfg.version }, { capabilities: {} });
    const hard = this.hardTimeoutMs;
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: this.spec.headers },
      // The SDK's per-request timeout only rejects the promise; it does not cut the socket.
      // POSTs get a hard abort so a hung upstream cannot pin connections. GET SSE streams are left alone.
      fetch: (input, init) => {
        if (init?.method === 'POST') {
          const signals = [AbortSignal.timeout(hard)];
          if (init.signal) signals.push(init.signal);
          return fetch(input, { ...init, signal: AbortSignal.any(signals) });
        }
        return fetch(input, init);
      },
    });
    client.onerror = (err) => {
      // Every failed POST is reported here AND via the rejected promise, hence debug level only.
      this.log.debug({ server: this.spec.slug, err: describeTransportError(err) }, 'upstream transport error');
    };
    await client.connect(transport, { timeout: this.cfg.connectTimeoutMs });
    this.client = client;
    return client;
  }
}

export function firstText(result: CallToolResult): string | undefined {
  for (const c of result.content) if (c.type === 'text') return c.text;
  return undefined;
}
