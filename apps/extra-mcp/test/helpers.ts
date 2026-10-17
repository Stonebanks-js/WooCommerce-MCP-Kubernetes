/** Shared test plumbing: start an app on a random port and talk to it with the SDK Client. */
import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '../src/logger.ts';
import { createApp, type ExtraMcpApp, type ServerDefinition } from '../src/server.ts';

export interface RunningServer {
  url: string;
  mcpUrl: string;
  token: string;
  extra: ExtraMcpApp;
  close(): Promise<void>;
}

export async function startTestServer(
  definition: ServerDefinition,
  token: string = `tok_${definition.name}_${randomUUID()}`,
  allowedOrigins: readonly string[] = [],
): Promise<RunningServer> {
  const extra = createApp(definition, {
    token,
    allowedOrigins,
    log: createLogger(definition.name, 'silent'),
  });
  const httpServer = await new Promise<HttpServer>((resolve) => {
    const server = extra.app.listen(0, '127.0.0.1', () => resolve(server));
  });
  const { port } = httpServer.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    mcpUrl: `${url}/mcp`,
    token,
    extra,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.closeAllConnections();
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export function apiKey(token: string): Record<string, string> {
  return { 'X-Api-Key': token };
}

export async function connectClient(mcpUrl: string, headers: Record<string, string>): Promise<Client> {
  const client = new Client({ name: 'extra-mcp-tests', version: '0.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers } });
  await client.connect(transport, { timeout: 5000 });
  return client;
}

export interface ToolOutcome {
  raw: CallToolResult;
  text: string;
  isError: boolean;
  data: Record<string, unknown>;
}

/** Call a tool and unpack the first text block + structuredContent. */
export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolOutcome> {
  const raw = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const first = raw.content[0];
  const text = first && first.type === 'text' ? first.text : '';
  return {
    raw,
    text,
    isError: raw.isError === true,
    data: (raw.structuredContent ?? {}) as Record<string, unknown>,
  };
}

export async function listTools(client: Client): Promise<Tool[]> {
  const { tools } = await client.listTools();
  return tools;
}

/** Raw JSON-RPC POST with the headers the Streamable HTTP transport insists on. */
export function rawPost(
  mcpUrl: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(mcpUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body,
  });
}

export const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'raw-test', version: '0.0.0' },
  },
});

/** Parse a JSON response body as a loosely typed object (fetch types it as unknown). */
export async function readJson(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}
