import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { Logger } from 'pino';
import type { Config } from './config.ts';
import { createMcpRouter, createMcpServer } from './mcp.ts';
import { createReadiness, type Readiness } from './readiness.ts';
import { packageVersion } from './version.ts';
import { WooClient, type FetchLike } from './woo/client.ts';

/**
 * Builds the express app without binding a port, so tests can start it on a
 * random port against a fake WooCommerce and the real entrypoint can wire
 * signals and logging around it.
 */

export const SERVER_NAME = 'woo-mcp';

export interface AppOptions {
  config: Config;
  logger: Logger;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetch?: FetchLike;
  /** Readiness cache TTL (ms); contracts §12 says 10 s. */
  readinessTtlMs?: number;
}

export interface App {
  app: Express;
  woo: WooClient;
  readiness: Readiness;
  version: string;
}

export function createApp(opts: AppOptions): App {
  const { config, logger } = opts;
  const version = packageVersion();

  const woo = new WooClient({
    baseUrl: config.wooBaseUrl,
    username: config.wooUsername,
    appPassword: config.wooAppPassword,
    timeoutMs: config.wooTimeoutMs,
    logger: logger.child({ component: 'woo' }),
    fetch: opts.fetch,
  });

  const readiness = createReadiness({
    probe: () => woo.ping(AbortSignal.timeout(Math.min(config.wooTimeoutMs, 5_000))),
    ttlMs: opts.readinessTtlMs ?? 10_000,
  });

  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  // Access log: one JSON line per request, probes at debug level.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      const entry = { method: req.method, path: req.path, status: res.statusCode, durationMs: Math.round(durationMs) };
      if (req.path === '/healthz' || req.path === '/readyz') logger.debug(entry, 'request');
      else logger.info(entry, 'request');
    });
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ status: 'ok', service: SERVER_NAME, version });
  });

  app.get('/readyz', async (_req, res) => {
    const state = await readiness.check();
    res.set('Cache-Control', 'no-store');
    if (state.ok) {
      res.status(200).json({ status: 'ready', woo: { ok: true, status: state.status, checkedAt: state.checkedAt } });
    } else {
      res.status(503).json({
        status: 'not-ready',
        woo: { ok: false, status: state.status, error: state.error, checkedAt: state.checkedAt },
      });
    }
  });

  const instructions =
    `This server exposes the WooCommerce store "${config.storeName}" (${config.storeUrl}). ` +
    'Use list_products / get_product / create_product for the catalogue and list_orders / get_order / ' +
    'update_order_status for orders. Dates for list_orders may be calendar days (YYYY-MM-DD) in the ' +
    'store timezone. Results are compact JSON; errors from WooCommerce come back as error results with a message.';

  app.use(
    createMcpRouter({
      authToken: config.mcpAuthToken,
      allowedOrigins: config.allowedOrigins,
      logger: logger.child({ component: 'mcp' }),
      createServer: () =>
        createMcpServer(
          {
            woo,
            storeName: config.storeName,
            storeUrl: config.storeUrl,
            wooBaseUrl: config.wooBaseUrl,
            logger: logger.child({ component: 'tools' }),
          },
          {
            name: SERVER_NAME,
            version,
            title: `${config.storeName} (WooCommerce)`,
            instructions,
          },
        ),
    }),
  );

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'unhandled error');
    if (!res.headersSent) res.status(500).json({ error: 'internal' });
  });

  return { app, woo, readiness, version };
}
