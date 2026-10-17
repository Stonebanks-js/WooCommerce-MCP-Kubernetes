import { Router } from 'express';

export interface HealthState {
  /** True once SIGTERM/SIGINT was received: readiness flips to 503 so the pod drains. */
  isShuttingDown(): boolean;
}

/**
 * `GET /healthz` (liveness) and `GET /readyz` (readiness), unauthenticated, as every container in
 * this repo exposes them. Both answer `{"ok":true,"server":"<name>"}`; readiness answers 503 while
 * the process is draining.
 */
export function healthRouter(server: string, state: HealthState): Router {
  const router = Router();
  router.get('/healthz', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ ok: true, server });
  });
  router.get('/readyz', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    if (state.isShuttingDown()) {
      res.status(503).json({ ok: false, server, reason: 'shutting down' });
      return;
    }
    res.json({ ok: true, server });
  });
  return router;
}
