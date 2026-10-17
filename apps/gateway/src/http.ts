import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import type { Metrics } from './core/metrics.ts';

export interface Listening {
  server: Server;
  port: number;
  close(): Promise<void>;
}

function listen(server: Server, port: number, host?: string): Promise<Listening> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const addr = server.address() as AddressInfo;
      resolve({
        server,
        port: addr.port,
        close: () =>
          new Promise<void>((res) => {
            server.closeAllConnections?.();
            server.close(() => res());
          }),
      });
    });
  });
}

export function listenApp(app: Express, port: number, host?: string): Promise<Listening> {
  const server = createServer(app);
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  return listen(server, port, host);
}

/** Separate server for Prometheus; never referenced by the Ingress. */
export function listenMetrics(metrics: Metrics, port: number, host?: string): Promise<Listening> {
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && (req.url === '/metrics' || req.url?.startsWith('/metrics?'))) {
      try {
        const body = await metrics.render();
        res.writeHead(200, { 'content-type': metrics.contentType });
        res.end(body);
      } catch (err) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end((err as Error).message);
      }
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  return listen(server, port, host);
}
