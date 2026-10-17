import { pino, type Logger } from 'pino';

export type { Logger };

/** JSON lines to stdout; level from LOG_LEVEL (default info). Tests pass 'silent'. */
export function createLogger(
  server: string,
  level: string = process.env.LOG_LEVEL ?? 'info',
): Logger {
  return pino({
    name: `extra-mcp:${server}`,
    level,
    base: { server },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
