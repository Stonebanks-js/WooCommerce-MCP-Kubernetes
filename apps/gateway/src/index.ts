import { buildGateway } from './app.ts';
import { loadConfig } from './config.ts';
import { migrate } from './db/migrate.ts';
import { PgDb } from './db/pg.ts';
import { listenApp, listenMetrics } from './http.ts';
import { createLogger } from './log.ts';
import { seed } from './seed.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.logLevel);
  const db = new PgDb(config.databaseUrl);

  await migrate(db, log);
  await seed(db, config, log);

  const gw = buildGateway({ config, db, log });
  await gw.registry.start();
  const http = await listenApp(gw.app, config.port);
  const metrics = await listenMetrics(gw.metrics, config.metricsPort);
  log.info(
    { port: http.port, metricsPort: metrics.port, publicUrl: config.publicUrl, llm: config.llm.provider, servers: gw.registry.snapshot().length },
    'gateway listening',
  );

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    const timer = setTimeout(() => process.exit(1), 10_000);
    timer.unref();
    await Promise.allSettled([http.close(), metrics.close(), gw.registry.stop()]);
    await db.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(JSON.stringify({ level: 'fatal', msg: (err as Error).message }));
  process.exit(1);
});
