import { Router } from 'express';
import type { Config } from '../config.ts';

/** `GET /api/config` — public, lets the dashboard render the connect page and the chat state. */
export function configRouter(config: Config): Router {
  const r = Router();
  r.get('/', (_req, res) => {
    res.json({
      publicUrl: config.publicUrl,
      mcpUrl: `${config.publicUrl}/mcp`,
      chat: { enabled: config.llm.provider !== 'none', provider: config.llm.provider, model: config.llm.model },
      version: config.version,
    });
  });
  return r;
}
