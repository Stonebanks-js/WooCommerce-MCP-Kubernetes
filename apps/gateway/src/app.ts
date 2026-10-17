import express, { type Express, type RequestHandler } from 'express';
import { auditRouter } from './api/audit.ts';
import { authRouter } from './api/auth.ts';
import { chatRouter } from './api/chat.ts';
import { configRouter } from './api/config.ts';
import { errorHandler } from './api/errors.ts';
import { keysRouter } from './api/keys.ts';
import { serversRouter } from './api/servers.ts';
import { toolsRouter } from './api/tools.ts';
import { usersRouter } from './api/users.ts';
import { attachSession } from './auth/middleware.ts';
import { ChatAgent } from './chat/agent.ts';
import { createProvider } from './chat/providers/index.ts';
import type { ChatProvider } from './chat/types.ts';
import type { Config } from './config.ts';
import { GatewayCore } from './core/gatewayCore.ts';
import { Metrics } from './core/metrics.ts';
import { RateLimiter } from './core/ratelimit.ts';
import type { Db } from './db/db.ts';
import type { Logger } from './log.ts';
import { mcpRouter, oauthDiscoveryRouter } from './mcp/endpoint.ts';
import { UpstreamRegistry } from './upstream/registry.ts';

export interface Gateway {
  app: Express;
  registry: UpstreamRegistry;
  core: GatewayCore;
  metrics: Metrics;
  provider: ChatProvider | null;
}

export interface GatewayOptions {
  config: Config;
  db: Db;
  log: Logger;
  /** Override the LLM provider (tests); `undefined` = derive from config. */
  provider?: ChatProvider | null;
  /** Skip prom-client default metrics (tests create many registries). */
  defaultMetrics?: boolean;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Low-cardinality route label: path with ids/numbers replaced, unknown paths collapsed to `other`. */
export function routeLabel(originalUrl: string): string {
  const path = originalUrl.split('?')[0] ?? '';
  if (!(path.startsWith('/api/') || path === '/mcp' || path === '/healthz' || path === '/readyz')) return path.startsWith('/.well-known') ? '/.well-known/*' : 'other';
  return path.replace(/\/+$/, '').replace(UUID_RE, ':id').replace(/\/\d+(?=\/|$)/g, '/:n').slice(0, 80);
}

function requestMetrics(metrics: Metrics): RequestHandler {
  return (req, res, next) => {
    const route = routeLabel(req.originalUrl);
    res.on('finish', () => {
      metrics.httpRequests.inc({ route, method: req.method, status: String(res.statusCode) });
    });
    next();
  };
}

function requestLog(log: Logger): RequestHandler {
  return (req, res, next) => {
    const started = performance.now();
    res.on('finish', () => {
      if (req.path === '/healthz' || req.path === '/readyz') return;
      // Never log headers: Authorization / X-Api-Key / Cookie stay out of the logs.
      log.debug({ method: req.method, path: req.path, status: res.statusCode, ms: Math.round(performance.now() - started) }, 'request');
    });
    next();
  };
}

function cors(origin: string): RequestHandler {
  const allowed = new Set(origin.split(',').map((s) => s.trim()).filter(Boolean));
  return (req, res, next) => {
    const o = req.headers.origin;
    if (o && allowed.has(o)) {
      res.setHeader('Access-Control-Allow-Origin', o);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}

/** Builds registry, core, metrics, chat agent and the Express app. The registry is NOT started here. */
export function buildGateway(opts: GatewayOptions): Gateway {
  const { config, db, log } = opts;
  const metrics = new Metrics(opts.defaultMetrics ?? true);
  const registry = new UpstreamRegistry(db, config, log, metrics);
  const core = new GatewayCore({ db, registry, metrics, rateLimiter: new RateLimiter(config.rateLimitPerMinute), log });
  const provider = opts.provider === undefined ? createProvider(config.llm) : opts.provider;
  const agent = provider ? new ChatAgent(core, provider, { maxIterations: config.chatMaxIterations, toolSearchThreshold: config.chatToolSearchThreshold }, log) : null;

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  if (config.corsOrigin) app.use(cors(config.corsOrigin));
  app.use(requestLog(log));
  app.use(requestMetrics(metrics));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/readyz', async (_req, res) => {
    try {
      await db.query('select 1');
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false, error: 'database_unavailable' });
    }
  });

  app.use(oauthDiscoveryRouter());
  app.use('/mcp', mcpRouter({ db, core, config, log }));

  const api = express.Router();
  api.use(express.json({ limit: '1mb' }));
  api.use(attachSession(db));
  api.use('/auth', authRouter(db, config.cookieSecure));
  api.use('/config', configRouter(config));
  api.use('/servers', serversRouter(db, config, registry));
  api.use('/tools', toolsRouter(core));
  api.use('/users', usersRouter(db, config));
  api.use('/keys', keysRouter(db));
  api.use('/audit', auditRouter(db));
  api.use('/chat', chatRouter(agent));
  api.use((_req, res) => {
    res.status(404).json({ error: 'not_found', message: 'No such API route' });
  });
  app.use('/api', api);

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found', message: 'Not found' });
  });
  app.use(errorHandler(log));
  return { app, registry, core, metrics, provider };
}
