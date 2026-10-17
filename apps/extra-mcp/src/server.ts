/**
 * Shared Streamable HTTP wiring for both servers (docs/contracts.md §3):
 *
 * - `POST /mcp` is stateless: a fresh `McpServer` + `StreamableHTTPServerTransport` per request,
 *   `sessionIdGenerator: undefined`, no `Mcp-Session-Id`. `GET`/`DELETE` (and anything else) → 405.
 * - A static credential guards `/mcp`: `Authorization: Bearer <MCP_AUTH_TOKEN>` (notes) or
 *   `X-Api-Key: <MCP_AUTH_TOKEN>` (utils), compared in constant time. Missing/invalid →
 *   `401` + `WWW-Authenticate: Bearer error="invalid_token", error_description="..."` (RFC 6750,
 *   deliberately without `resource_metadata` so no OAuth discovery is advertised) + JSON body
 *   `{"error":"invalid_token","error_description":"..."}`.
 * - If an `Origin` header is present on `/mcp` it must be in `ALLOWED_ORIGINS` (default: none),
 *   otherwise `403` (MCP spec MUST, DNS-rebinding protection).
 * - `GET /healthz` and `GET /readyz` are unauthenticated.
 * - pino JSON logs to stdout; graceful shutdown on SIGTERM/SIGINT (readiness flips to 503 first).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { healthRouter } from './health.ts';
import { createLogger, type Logger } from './logger.ts';

export type AuthSpec = { kind: 'bearer' } | { kind: 'header'; name: string };

export type ServerName = 'notes' | 'utils';

export interface ServerDefinition {
  name: ServerName;
  version: string;
  auth: AuthSpec;
  /** Sent to clients in `initialize`; a short hint about what the server is for. */
  instructions?: string;
  /**
   * Called once per app. Returns the function that registers tools on each per-request
   * `McpServer`, so state that must outlive a request (the notes store) is created here.
   */
  createRegistrar(log: Logger): (server: McpServer) => void;
}

export interface CreateAppOptions {
  /** The static credential clients must present (`MCP_AUTH_TOKEN`). */
  token: string;
  /**
   * Origins allowed to send an `Origin` header to `/mcp` (`ALLOWED_ORIGINS`, comma-separated).
   * Default empty: any request carrying an `Origin` header is answered 403. Requests without
   * an `Origin` header (every non-browser MCP client, including the gateway) are unaffected.
   */
  allowedOrigins?: readonly string[];
  log?: Logger;
}

export interface ExtraMcpApp {
  app: Express;
  log: Logger;
  definition: ServerDefinition;
  /** Flip readiness to 503; used by the SIGTERM handler and by tests. */
  beginShutdown(): void;
  isShuttingDown(): boolean;
}

export const DEFAULT_PORT = 8080;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
/** Matches the transport's own cap on raw bodies. */
const MAX_BODY = '4mb';

/** Human description of the credential a server expects, for logs and docs (never the value). */
export function describeAuth(auth: AuthSpec): string {
  return auth.kind === 'bearer'
    ? 'Authorization: Bearer <MCP_AUTH_TOKEN>'
    : `${auth.name}: <MCP_AUTH_TOKEN>`;
}

/** Pull the presented credential out of the request, or undefined when it is absent/malformed. */
export function extractCredential(auth: AuthSpec, req: Request): string | undefined {
  if (auth.kind === 'bearer') {
    const header = req.get('authorization');
    if (header === undefined) return undefined;
    const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
    return match?.[1];
  }
  const value = req.get(auth.name);
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Constant-time string comparison that does not leak length (compares SHA-256 digests). */
export function safeEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
}

/** Text used in both the `WWW-Authenticate` challenge and the JSON body (docs/contracts.md §3). */
export const UNAUTHORIZED_DESCRIPTION = 'Missing or invalid credential';

/**
 * RFC 6750 challenge. No `resource_metadata`, so clients (Claude Code, Inspector, the gateway)
 * see a plain "bad credential" and never start OAuth discovery against these servers.
 */
export function wwwAuthenticateValue(description: string = UNAUTHORIZED_DESCRIPTION): string {
  const safe = description.replace(/["\\\r\n]/g, ' ');
  return `Bearer error="invalid_token", error_description="${safe}"`;
}

function authGuard(auth: AuthSpec, token: string, log: Logger): RequestHandler {
  return (req, res, next) => {
    const presented = extractCredential(auth, req);
    if (presented === undefined || !safeEqual(presented, token)) {
      log.warn(
        { method: req.method, path: req.path, reason: presented === undefined ? 'missing' : 'invalid' },
        'unauthorized /mcp request',
      );
      res
        .status(401)
        .set('WWW-Authenticate', wwwAuthenticateValue())
        .json({ error: 'invalid_token', error_description: UNAUTHORIZED_DESCRIPTION });
      return;
    }
    next();
  };
}

/** Canonical form for comparing origins: lower-case, no trailing slash. */
export function normaliseOrigin(origin: string): string {
  return origin.trim().toLowerCase().replace(/\/+$/, '');
}

/** Parse `ALLOWED_ORIGINS` (comma-separated); blanks are ignored. */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map(normaliseOrigin)
    .filter((o) => o.length > 0);
}

/**
 * MCP spec: servers MUST validate the `Origin` header to prevent DNS rebinding. Non-browser
 * clients never send one, so the check only bites browser-originated requests, which these
 * servers do not serve unless `ALLOWED_ORIGINS` says so.
 */
function originGuard(allowedOrigins: readonly string[], log: Logger): RequestHandler {
  const allowed = new Set(allowedOrigins.map(normaliseOrigin));
  return (req, res, next) => {
    const origin = req.get('origin');
    if (origin === undefined) {
      next();
      return;
    }
    if (allowed.has(normaliseOrigin(origin))) {
      next();
      return;
    }
    log.warn({ method: req.method, path: req.path, origin }, 'forbidden origin on /mcp');
    res.status(403).json({ error: 'forbidden', error_description: `Origin "${origin}" is not allowed` });
  };
}

function requestLogger(log: Logger): RequestHandler {
  return (req, res, next) => {
    const started = performance.now();
    res.on('finish', () => {
      const entry = {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Math.round(performance.now() - started),
      };
      if (req.path === '/healthz' || req.path === '/readyz') log.debug(entry, 'request');
      else log.info(entry, 'request');
    });
    next();
  };
}

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

function errorHandler(log: Logger) {
  // Four parameters: that is how Express recognises an error-handling middleware.
  return (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    const e = err as { status?: number; statusCode?: number; type?: string; message?: string };
    const status = e.status ?? e.statusCode ?? 500;
    if (res.headersSent) {
      res.end();
      return;
    }
    if (status >= 400 && status < 500) {
      // body-parser failures: malformed JSON, oversized or unparsable bodies.
      if (e.type === 'entity.parse.failed') {
        jsonRpcError(res, 400, -32700, 'Parse error: request body is not valid JSON');
      } else {
        jsonRpcError(res, status, -32600, e.message ?? 'Bad request');
      }
      return;
    }
    log.error({ err }, 'unhandled error');
    jsonRpcError(res, 500, -32603, 'Internal server error');
  };
}

export function createApp(definition: ServerDefinition, options: CreateAppOptions): ExtraMcpApp {
  const log = options.log ?? createLogger(definition.name);
  const token = options.token;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('MCP_AUTH_TOKEN must be a non-empty string');
  }
  const registerTools = definition.createRegistrar(log);
  let shuttingDown = false;

  const app = express();
  app.disable('x-powered-by');
  app.use(requestLogger(log));
  app.use(healthRouter(definition.name, { isShuttingDown: () => shuttingDown }));

  // Order on /mcp: Origin (403) → credential (401) → method (405) → body parsing (400) → MCP.
  app.use('/mcp', originGuard(options.allowedOrigins ?? [], log));
  app.post(
    '/mcp',
    authGuard(definition.auth, token, log),
    express.json({ limit: MAX_BODY }),
    async (req, res) => {
      // Stateless: one Server + one transport per request (a stateless transport can serve
      // exactly one request; see briefs/sdk-facts.md).
      const server = new McpServer(
        { name: `urumi-${definition.name}-mcp`, version: definition.version },
        { capabilities: { tools: {} }, instructions: definition.instructions },
      );
      registerTools(server);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        log.error({ err }, 'mcp request failed');
        if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Internal server error');
      }
    },
  );
  app.all('/mcp', (_req, res) => {
    res.set('Allow', 'POST');
    jsonRpcError(res, 405, -32000, 'Method not allowed.');
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });
  app.use(errorHandler(log));

  return {
    app,
    log,
    definition,
    beginShutdown: () => {
      shuttingDown = true;
    },
    isShuttingDown: () => shuttingDown,
  };
}

function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT;
  const trimmed = raw.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return undefined;
  const port = Number(trimmed);
  return port <= 65535 ? port : undefined;
}

function parseTimeout(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_SHUTDOWN_TIMEOUT_MS;
}

/**
 * Process entrypoint used by `src/notes.ts`, `src/utils.ts` and `src/index.ts`: reads `PORT`,
 * `MCP_AUTH_TOKEN`, `ALLOWED_ORIGINS`, `LOG_LEVEL`, `SHUTDOWN_TIMEOUT_MS`; exits 1 on misconfiguration; installs
 * the SIGTERM/SIGINT handler.
 */
export function startServer(
  definition: ServerDefinition,
  env: NodeJS.ProcessEnv = process.env,
): HttpServer {
  const log = createLogger(definition.name, env.LOG_LEVEL);
  const token = env.MCP_AUTH_TOKEN?.trim() ?? '';
  if (token.length === 0) {
    log.fatal('MCP_AUTH_TOKEN is required: the static credential clients must present on /mcp');
    process.exit(1);
  }
  const port = parsePort(env.PORT);
  if (port === undefined) {
    log.fatal({ PORT: env.PORT }, 'PORT must be an integer between 0 and 65535');
    process.exit(1);
  }
  const shutdownTimeoutMs = parseTimeout(env.SHUTDOWN_TIMEOUT_MS);
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);

  const { app, beginShutdown } = createApp(definition, { token, log, allowedOrigins });
  const httpServer = app.listen(port, () => {
    // Report the bound port (PORT=0 asks the OS for a free one), not the configured value.
    const address = httpServer.address();
    const bound = address !== null && typeof address === 'object' ? address.port : port;
    log.info(
      { port: bound, auth: describeAuth(definition.auth), allowedOrigins, version: definition.version },
      'listening',
    );
  });
  httpServer.on('error', (err) => {
    log.fatal({ err }, 'failed to listen');
    process.exit(1);
  });

  let closing = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (closing) return;
    closing = true;
    beginShutdown();
    log.info({ signal, timeoutMs: shutdownTimeoutMs }, 'shutting down: readiness is now 503');
    httpServer.close((err) => {
      clearInterval(sweep);
      clearTimeout(force);
      if (err) log.warn({ err }, 'close reported an error');
      log.info('http server closed');
      process.exit(0);
    });
    // `close()` sweeps idle keep-alive connections once, at call time. The SDK's SSE responses
    // carry `Connection: keep-alive`, so a connection that is busy at that moment becomes idle
    // afterwards and would otherwise linger until the force timeout (undici pools connections
    // this way). Keep sweeping while draining so the process exits as soon as the last
    // in-flight request has been answered.
    const sweep = setInterval(() => httpServer.closeIdleConnections(), 250);
    sweep.unref();
    const force = setTimeout(() => {
      log.warn('shutdown timeout reached, closing remaining connections');
      httpServer.closeAllConnections();
    }, shutdownTimeoutMs);
    force.unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  return httpServer;
}
