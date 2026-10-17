import { Router, type Response } from 'express';
import { z } from 'zod';
import { currentUser, requireSession } from '../auth/middleware.ts';
import type { ChatAgent } from '../chat/agent.ts';
import type { ChatEvent } from '../chat/types.ts';
import { parseBody, wrap } from './errors.ts';

const bodySchema = z.object({
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(100_000) })).min(1).max(200),
});

export function writeSse(res: Response, e: ChatEvent): void {
  if (res.writableEnded) return;
  res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
}

/** `POST /api/chat` — SSE per contracts §11; 503 `chat_disabled` when no provider is configured. */
export function chatRouter(agent: ChatAgent | null): Router {
  const r = Router();
  r.post(
    '/',
    requireSession,
    wrap(async (req, res) => {
      if (!agent) {
        res.status(503).json({ error: 'chat_disabled', message: 'No LLM provider is configured (LLM_PROVIDER=none)' });
        return;
      }
      const { messages } = parseBody(bodySchema, req.body);
      const user = currentUser(req);
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      // Stop the tool loop as soon as the client disconnects (Stop button, navigation, closed tab).
      const ac = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) ac.abort();
      });
      await agent.run(user, messages, (e) => writeSse(res, e), ac.signal);
      res.end();
    }),
  );
  return r;
}
