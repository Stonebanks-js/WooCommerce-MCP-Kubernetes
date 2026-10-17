import { Router } from 'express';
import { currentUser, requireSession } from '../auth/middleware.ts';
import type { GatewayCore } from '../core/gatewayCore.ts';

/** `GET /api/tools` — exactly what this user sees over MCP. */
export function toolsRouter(core: GatewayCore): Router {
  const r = Router();
  r.get('/', requireSession, (req, res) => {
    res.json({ tools: core.listToolsFor(currentUser(req)) });
  });
  return r;
}
