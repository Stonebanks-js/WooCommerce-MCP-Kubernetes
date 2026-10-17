import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireSession } from '../auth/middleware.ts';
import { queryAudit, type AuditQuery } from '../core/audit.ts';
import type { Db } from '../db/db.ts';
import { ApiError, wrap } from './errors.ts';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().min(1).optional(),
  userId: z.string().uuid().optional(),
  serverId: z.string().uuid().optional(),
  outcome: z.enum(['success', 'error', 'timeout', 'unreachable', 'denied', 'not_found', 'rate_limited']).optional(),
  source: z.enum(['mcp', 'chat']).optional(),
});

/** `GET /api/audit` — members only ever see their own rows. */
export function auditRouter(db: Db): Router {
  const r = Router();
  r.get(
    '/',
    requireSession,
    wrap(async (req, res) => {
      const parsed = querySchema.safeParse(req.query);
      if (!parsed.success) throw new ApiError(400, 'validation_error', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      const me = currentUser(req);
      const q: AuditQuery = { limit: parsed.data.limit };
      if (parsed.data.before !== undefined) q.before = parsed.data.before;
      if (parsed.data.serverId) q.serverId = parsed.data.serverId;
      if (parsed.data.outcome) q.outcome = parsed.data.outcome;
      if (parsed.data.source) q.source = parsed.data.source;
      if (me.role === 'admin') {
        if (parsed.data.userId) q.userId = parsed.data.userId;
      } else {
        q.userId = me.id;
      }
      res.json(await queryAudit(db, q));
    }),
  );
  return r;
}
