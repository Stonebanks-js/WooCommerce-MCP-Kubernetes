/**
 * Local development without Postgres: boots the gateway on an in-process PGlite database with the
 * mock LLM provider and a seeded admin (admin@example.com / admin12345). Data lives in memory only.
 *
 *   npm run dev:pglite            # http://localhost:8080, metrics on :9090
 *   PORT=8081 npm run dev:pglite
 */
import { buildGateway } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { migrate } from '../src/db/migrate.ts';
import { PgliteDb } from '../src/db/pglite.ts';
import { listenApp, listenMetrics } from '../src/http.ts';
import { createLogger } from '../src/log.ts';
import { seed } from '../src/seed.ts';

const port = process.env.PORT ?? '8080';
const config = loadConfig({
  ...process.env,
  PORT: port,
  DATABASE_URL: 'pglite://memory',
  GATEWAY_ENCRYPTION_KEY: process.env.GATEWAY_ENCRYPTION_KEY ?? Buffer.alloc(32, 42).toString('base64'),
  SESSION_SECRET: process.env.SESSION_SECRET ?? 'dev-session-secret',
  PUBLIC_URL: process.env.PUBLIC_URL ?? `http://localhost:${port}`,
  ADMIN_EMAIL: process.env.ADMIN_EMAIL ?? 'admin@example.com',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ?? 'admin12345',
  DEMO_MEMBER_EMAIL: process.env.DEMO_MEMBER_EMAIL ?? 'member@example.com',
  DEMO_MEMBER_PASSWORD: process.env.DEMO_MEMBER_PASSWORD ?? 'member12345',
  LLM_PROVIDER: process.env.LLM_PROVIDER ?? 'mock',
  ALLOW_PRIVATE_UPSTREAMS: process.env.ALLOW_PRIVATE_UPSTREAMS ?? 'true',
  CORS_ORIGIN: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
});
const log = createLogger(config.logLevel);
const db = new PgliteDb();
await migrate(db, log);
await seed(db, config, log);
const gw = buildGateway({ config, db, log });
await gw.registry.start();
const http = await listenApp(gw.app, config.port);
const metrics = await listenMetrics(gw.metrics, config.metricsPort);
log.info({ port: http.port, metricsPort: metrics.port, admin: config.adminEmail, llm: config.llm.provider }, 'dev gateway on PGlite listening');

const stop = async () => {
  await Promise.allSettled([http.close(), metrics.close(), gw.registry.stop()]);
  await db.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
