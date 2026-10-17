import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';

export interface FakeUpstreamAuth {
  /** `authorization` means `Bearer <token>`; any other name is compared verbatim. */
  header: string;
  token: string;
}

export interface FakeUpstream {
  url: string;
  port: number;
  /** Number of POST /mcp requests that passed auth. */
  requests: number;
  close(): Promise<void>;
}

/**
 * In-process stateless Streamable HTTP upstream built with the SDK's McpServer, on a random port.
 * `register` adds tools to each per-request McpServer instance.
 */
export async function startFakeUpstream(name: string, register: (server: McpServer) => void, auth?: FakeUpstreamAuth): Promise<FakeUpstream> {
  const app = express();
  const state = { requests: 0 };
  app.post('/mcp', express.json({ limit: '4mb' }), async (req, res) => {
    if (auth) {
      const value = req.headers[auth.header.toLowerCase()];
      const expected = auth.header.toLowerCase() === 'authorization' ? `Bearer ${auth.token}` : auth.token;
      if (value !== expected) {
        res
          .status(401)
          .set('WWW-Authenticate', 'Bearer error="invalid_token", error_description="Missing or invalid credential"')
          .json({ error: 'invalid_token', error_description: 'Missing or invalid credential' });
        return;
      }
    }
    state.requests += 1;
    const server = new McpServer({ name, version: '0.0.1' });
    register(server);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  });
  const mna = (_req: express.Request, res: express.Response) => {
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  };
  app.get('/mcp', mna);
  app.delete('/mcp', mna);

  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    get requests() {
      return state.requests;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
