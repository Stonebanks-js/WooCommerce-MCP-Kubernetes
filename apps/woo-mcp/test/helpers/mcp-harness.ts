import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pino } from 'pino';
import { createApp, type App } from '../../src/app.ts';
import type { Config } from '../../src/config.ts';

export const TOKEN = 'test-bearer-token-0123456789';
export const WOO_USER = 'mcp-bot';
export const WOO_APP_PASSWORD = 'abcdEFGHijklMNOPqrstUVWX';

export const silentLogger = pino({ level: 'silent' });

export function testConfig(overrides: Partial<Config> & { wooBaseUrl: string }): Config {
  return {
    port: 0,
    wooUsername: WOO_USER,
    wooAppPassword: WOO_APP_PASSWORD,
    mcpAuthToken: TOKEN,
    storeName: 'Test Store',
    storeUrl: 'http://store.test',
    wooTimeoutMs: 2_000,
    allowedOrigins: [],
    logLevel: 'silent',
    ...overrides,
  };
}

export interface RunningMcp extends App {
  /** Origin of the MCP HTTP server, e.g. http://127.0.0.1:54321 */
  url: string;
  mcpUrl: string;
  close(): Promise<void>;
}

/** Start the real express app on a random port. */
export async function startMcp(config: Config, extra: { readinessTtlMs?: number } = {}): Promise<RunningMcp> {
  const built = createApp({ config, logger: silentLogger, readinessTtlMs: extra.readinessTtlMs });
  const server: Server = await new Promise((resolve) => {
    const s = built.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  return {
    ...built,
    url,
    mcpUrl: `${url}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** Connect an SDK client with the bearer header (contracts §3). */
export async function connectClient(mcpUrl: string, token: string = TOKEN): Promise<Client> {
  const client = new Client({ name: 'woo-mcp-test', version: '0.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

export async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

/** The text block of a result (every tool returns exactly one). */
export function textOf(result: CallToolResult): string {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error(`expected a text block, got ${JSON.stringify(result.content)}`);
  return first.text;
}

export function dataOf<T = Record<string, unknown>>(result: CallToolResult): T {
  if (result.isError) throw new Error(`tool returned an error: ${textOf(result)}`);
  return JSON.parse(textOf(result)) as T;
}

/** Raw JSON-RPC POST to /mcp with the headers the transport requires. */
export async function rawPost(mcpUrl: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(mcpUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

export const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'raw', version: '0' },
  },
};
