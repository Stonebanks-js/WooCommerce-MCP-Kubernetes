import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { ZodType } from 'zod';
import type { Logger } from '../log.ts';

/** Every REST error is `{error:<code>, message:<human text>}` with a 4xx/5xx status (contracts §9). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export const notFound = (what: string) => new ApiError(404, 'not_found', `${what} not found`);

/** Parses `req.body` with a zod schema; failures become 400 `validation_error`. */
export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    throw new ApiError(400, 'validation_error', msg);
  }
  return r.data;
}

/** Wraps an async handler so rejections reach the error middleware (Express 5 does this too; explicit for clarity). */
export const wrap =
  (fn: RequestHandler): RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

export function errorHandler(log: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (err instanceof ApiError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    const e = err as { type?: string; status?: number; message?: string; code?: string };
    if (e?.code === '23505') {
      // Postgres unique_violation: the application-level existence check raced a concurrent insert.
      res.status(409).json({ error: 'conflict', message: 'A record with the same unique value already exists' });
      return;
    }
    if (e?.type === 'entity.parse.failed' || e?.type === 'entity.too.large' || (typeof e?.status === 'number' && e.status >= 400 && e.status < 500)) {
      res.status(e.status ?? 400).json({ error: 'bad_request', message: e.message ?? 'Bad request' });
      return;
    }
    log.error({ err: e?.message ?? String(err), path: req.path }, 'unhandled error');
    res.status(500).json({ error: 'internal_error', message: 'Internal server error' });
  };
}
