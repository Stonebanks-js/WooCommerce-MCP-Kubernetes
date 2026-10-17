import { createHash, timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Logger } from 'pino';
import { registerTools, type ToolDeps } from './tools.ts';

/**
 * Streamable HTTP wiring (docs/contracts.md §3), stateless:
 *  - if an `Origin` header is present it must be one of the configured allowed
 *    origins (ALLOWED_ORIGINS, default none) or the request is answered 403
 *    (MCP spec MUST: DNS-rebinding protection). Checked before anything else
 *    because it needs no secret and must not depend on auth state;
 *  - `/mcp` requires `Authorization: Bearer <MCP_AUTH_TOKEN>` (timing-safe);
 *    missing/invalid -> 401 with `WWW-Authenticate: Bearer error="invalid_token",
 *    error_description="..."` (RFC 6750, deliberately without `resource_metadata`
 *    so no OAuth metadata is advertised) and the same error as a JSON body;
 *  - every POST gets a fresh McpServer + transport (a stateless transport serves one request);
 *  - GET and DELETE answer 405.
 */

export interface ServerInfoOptions {
  name: string;
  version: string;
  title: string;
  instructions: string;
}

export function createMcpServer(deps: ToolDeps, info: ServerInfoOptions): McpServer {
  const server = new McpServer(
    { name: info.name, version: info.version, title: info.title },
    { capabilities: { tools: {} }, instructions: info.instructions },
  );
  registerTools(server, deps);
  return server;
}

/** Constant-time string comparison that does not leak length either. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

export function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = m?.[1]?.trim();
  return token ? token : undefined;
}

/**
 * Normalise an origin for comparison: `new URL(x).origin`, lower-cased. Returns
 * undefined for anything that is not a parseable http(s) origin (including the
 * literal `null` that browsers send for opaque origins).
 */
export function normalizeOrigin(value: string): string | undefined {
  try {
    const u = new URL(value.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return u.origin.toLowerCase();
  } catch {
    return undefined;
  }
}

export const UNAUTHORIZED_DESCRIPTION = 'Missing or invalid credential';

export interface McpRouterOptions {
  authToken: string;
  /** Origins (scheme://host[:port]) allowed to send an `Origin` header. Empty = reject any Origin. */
  allowedOrigins?: readonly string[];
  createServer: () => McpServer;
  logger: Logger;
  /** express.json body limit; the SDK's own parser caps at 4 MiB, so match it. */
  bodyLimit?: string;
}

const METHOD_NOT_ALLOWED = {
  jsonrpc: '2.0',
  error: { code: -32000, message: 'Method not allowed.' },
  id: null,
} as const;

export function createMcpRouter(opts: McpRouterOptions): Router {
  const router = express.Router();
  const { logger } = opts;
  const allowedOrigins = new Set((opts.allowedOrigins ?? []).map((o) => normalizeOrigin(o) ?? o.toLowerCase()));

  // 1. Origin check (contracts §3 / MCP spec): only when the header is present.
  router.use('/mcp', (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin === undefined) {
      next();
      return;
    }
    const normalized = typeof origin === 'string' ? normalizeOrigin(origin) : undefined;
    if (normalized !== undefined && allowedOrigins.has(normalized)) {
      next();
      return;
    }
    logger.warn({ method: req.method, origin: String(origin).slice(0, 200) }, 'mcp: origin rejected');
    res
      .status(403)
      .set('Cache-Control', 'no-store')
      .json({ error: 'invalid_origin', error_description: `Origin "${String(origin).slice(0, 200)}" is not allowed` });
  });

  // 2. Static bearer (contracts §3).
  router.use('/mcp', (req: Request, res: Response, next: NextFunction) => {
    const token = bearerToken(req);
    if (token === undefined || !safeEqual(token, opts.authToken)) {
      logger.warn({ method: req.method, hasToken: token !== undefined }, 'mcp: unauthorized');
      res
        .status(401)
        .set('WWW-Authenticate', `Bearer error="invalid_token", error_description="${UNAUTHORIZED_DESCRIPTION}"`)
        .set('Cache-Control', 'no-store')
        .json({ error: 'invalid_token', error_description: UNAUTHORIZED_DESCRIPTION });
      return;
    }
    next();
  });

  router.post('/mcp', express.json({ limit: opts.bodyLimit ?? '4mb' }), async (req: Request, res: Response) => {
    const server = opts.createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    // Register before handleRequest so an early client disconnect still tears everything down.
    res.on('close', () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'mcp: request failed');
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  const methodNotAllowed = (_req: Request, res: Response): void => {
    res.status(405).set('Allow', 'POST').json(METHOD_NOT_ALLOWED);
  };
  router.get('/mcp', methodNotAllowed);
  router.delete('/mcp', methodNotAllowed);
  router.all('/mcp', methodNotAllowed);

  // express.json() failures (malformed JSON, oversized body, bad charset) -> JSON-RPC style errors.
  router.use('/mcp', (err: unknown, _req: Request, res: Response, next: NextFunction) => {
    const e = err as { type?: string; status?: number; message?: string } | undefined;
    if (e?.type === 'entity.parse.failed') {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: invalid JSON' }, id: null });
      return;
    }
    if (e?.type === 'entity.too.large') {
      res.status(413).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Request body too large' }, id: null });
      return;
    }
    if (typeof e?.status === 'number' && e.status >= 400 && e.status < 500) {
      res.status(e.status).json({ jsonrpc: '2.0', error: { code: -32600, message: e.message ?? 'Bad request' }, id: null });
      return;
    }
    next(err);
  });

  return router;
}
