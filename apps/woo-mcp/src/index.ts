import { pino } from 'pino';
import { createApp, SERVER_NAME } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';

/**
 * Entrypoint: config -> logger -> express app -> listen; graceful shutdown on
 * SIGTERM/SIGINT so rolling updates do not cut live tool calls.
 */

function main(): void {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    const message = err instanceof ConfigError ? err.message : String(err);
    // No logger yet: emit one JSON line by hand so the failure still looks like our logs.
    process.stderr.write(`${JSON.stringify({ level: 50, service: SERVER_NAME, msg: message })}\n`);
    process.exit(1);
  }

  const logger = pino({
    level: config.logLevel,
    base: { service: SERVER_NAME },
    redact: {
      paths: ['*.authorization', '*.appPassword', '*.password', '*.token', 'req.headers.authorization'],
      censor: '[redacted]',
    },
  });

  const { app, version } = createApp({ config, logger });

  const server = app.listen(config.port, '0.0.0.0', () => {
    logger.info(
      {
        port: config.port,
        version,
        wooBaseUrl: config.wooBaseUrl,
        wooUsername: config.wooUsername,
        storeName: config.storeName,
        storeUrl: config.storeUrl,
        wooTimeoutMs: config.wooTimeoutMs,
        allowedOrigins: config.allowedOrigins,
      },
      'woo-mcp listening',
    );
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      logger.warn('forcing exit after grace period');
      server.closeAllConnections();
      process.exit(0);
    }, 10_000);
    force.unref();
    server.close(() => {
      clearTimeout(force);
      logger.info('closed');
      process.exit(0);
    });
    server.closeIdleConnections();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason instanceof Error ? reason.message : String(reason) }, 'unhandled rejection');
  });
}

main();
