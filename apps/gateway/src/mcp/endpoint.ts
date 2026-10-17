import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import express, { Router, type Request, type Response } from 'express';
import { authenticateApiKey, extractApiKey, type ApiKeyAuth } from '../auth/apikeyAuth.ts';
import { originCheck } from '../auth/middleware.ts';
import type { Config } from '../config.ts';
import { toMcpTool, type GatewayCore } from '../core/gatewayCore.ts';
import type { Db } from '../db/db.ts';
import type { Logger } from '../log.ts';

export const SERVER_NAME = 'urumi-mcp-gateway';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by the /mcp auth middleware once the API key resolved to a user. */
    mcpAuth?: ApiKeyAuth;
  }
}

/** RFC 6750 shape, deliberately without `resource_metadata` so no OAuth discovery is advertised. */
export function sendUnauthorized(res: Response, why: string): void {
  const desc = why.replace(/["\\\r\n]/g, ' ');
  res
    .status(401)
    .set('WWW-Authenticate', `Bearer error="invalid_token", error_description="${desc}"`)
    .json({ error: 'invalid_token', error_description: why });
}

const methodNotAllowed = (_req: Request, res: Response) => {
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
};

/** Builds the per-request low-level Server that closes over the authenticated user. */
export function buildMcpServer(core: GatewayCore, auth: ApiKeyAuth, version: string): Server {
  const server = new Server(
    { name: SERVER_NAME, version },
    {
      capabilities: { tools: {} },
      instructions: 'Tools are named <server>__<tool>. Each call is audited under your API key.',
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: core.listToolsFor(auth.user).map(toMcpTool) }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const r = await core.callTool(auth.user, req.params.name, req.params.arguments ?? {}, { source: 'mcp', apiKeyId: auth.apiKeyId });
    return r.result;
  });
  return server;
}

export interface McpEndpointDeps {
  db: Db;
  core: GatewayCore;
  config: Config;
  log: Logger;
}

/** `/mcp`: stateless Streamable HTTP. One Server + one transport per POST; GET/DELETE → 405. */
export function mcpRouter({ db, core, config, log }: McpEndpointDeps): Router {
  const r = Router();
  // /mcp is bearer-authenticated, so DNS rebinding cannot ride on ambient credentials; the Origin
  // check (MCP spec MUST) therefore allows PUBLIC_URL, CORS_ORIGIN and MCP_ALLOWED_ORIGINS (by default
  // the MCP Inspector web UI on localhost:6274, which calls servers straight from the browser).
  const allowedOrigins = [
    new URL(config.publicUrl).origin,
    ...(config.corsOrigin ? config.corsOrigin.split(',').map((s) => s.trim()).filter(Boolean) : []),
    ...config.mcpAllowedOrigins,
  ];
  r.use(originCheck(allowedOrigins));

  // Authenticate from the headers BEFORE the (up to 4 MB) body is read and parsed.
  const requireApiKey: express.RequestHandler = async (req, res, next) => {
    try {
      const authResult = await authenticateApiKey(db, extractApiKey(req));
      if (!authResult.ok) {
        sendUnauthorized(res, authResult.reason);
        return;
      }
      req.mcpAuth = authResult.auth;
      next();
    } catch (err) {
      next(err);
    }
  };

  r.post('/', requireApiKey, express.json({ limit: '4mb' }), async (req, res) => {
    const authResult = { auth: req.mcpAuth as ApiKeyAuth };
    const server = buildMcpServer(core, authResult.auth, config.version);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      const msg = err instanceof McpError ? err.message : (err as Error).message;
      log.error({ err: msg }, 'mcp request failed');
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  });
  r.get('/', methodNotAllowed);
  r.delete('/', methodNotAllowed);
  r.all('/', (_req, res) => {
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  });
  return r;
}

/** SDK clients that try OAuth discovery must fail fast: these paths answer 404 JSON immediately. */
export const OAUTH_DISCOVERY_PATHS = [
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-authorization-server',
  '/.well-known/openid-configuration',
  '/register',
  '/authorize',
  '/token',
];

export function oauthDiscoveryRouter(): Router {
  const r = Router();
  for (const p of OAUTH_DISCOVERY_PATHS) {
    r.all([p, `${p}/*splat`], (_req, res) => {
      res.status(404).json({ error: 'not_found', message: 'This gateway uses static API keys; OAuth is not offered' });
    });
  }
  return r;
}
