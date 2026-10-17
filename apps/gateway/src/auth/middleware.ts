import { parseCookie } from 'cookie';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ApiError } from '../api/errors.ts';
import type { Db } from '../db/db.ts';
import { SESSION_COOKIE, findSessionUser } from './sessions.ts';
import { toUser, type User } from './users.ts';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by `attachSession` when the `gw_session` cookie resolves to an active user. */
    sessionUser?: User;
    sessionId?: string;
  }
}

/** Resolves the session cookie on every /api request (no error when absent). */
export function attachSession(db: Db): RequestHandler {
  return async (req, _res, next) => {
    try {
      const raw = req.headers.cookie;
      const id = raw ? parseCookie(raw)[SESSION_COOKIE] : undefined;
      if (id && /^[0-9a-f-]{36}$/i.test(id)) {
        const row = await findSessionUser(db, id);
        if (row && row.status === 'active') {
          req.sessionUser = toUser(row);
          req.sessionId = id;
        }
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function requireSession(req: Request, _res: Response, next: NextFunction): void {
  if (!req.sessionUser) return next(new ApiError(401, 'unauthenticated', 'Sign in required'));
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.sessionUser) return next(new ApiError(401, 'unauthenticated', 'Sign in required'));
  if (req.sessionUser.role !== 'admin') return next(new ApiError(403, 'forbidden', 'Admin role required'));
  next();
}

export function currentUser(req: Request): User {
  if (!req.sessionUser) throw new ApiError(401, 'unauthenticated', 'Sign in required');
  return req.sessionUser;
}

/**
 * MCP spec: when an `Origin` header is present it must be an allowed origin, else 403.
 * Allowed: PUBLIC_URL's origin and CORS_ORIGIN (comma separated).
 */
export function originCheck(allowed: string[]): RequestHandler {
  const set = new Set(allowed.map((o) => o.toLowerCase()));
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (!origin) return next();
    if (set.has(origin.toLowerCase())) return next();
    res.status(403).json({ error: 'forbidden_origin', message: `Origin ${origin} is not allowed` });
  };
}
