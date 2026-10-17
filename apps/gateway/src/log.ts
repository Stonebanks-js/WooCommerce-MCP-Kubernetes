import pino, { type Logger } from 'pino';

export type { Logger };

export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { service: 'gateway' },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Belt and braces: even if a request object is ever logged, credentials are masked.
    redact: {
      paths: ['req.headers.authorization', 'req.headers["x-api-key"]', 'req.headers.cookie', 'authSecret', 'password', 'plaintext'],
      censor: '[redacted]',
    },
  });
}
