import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { buildGateway, type Gateway } from '../app.ts';
import { loadConfig } from '../config.ts';
import { migrate } from '../db/migrate.ts';
import { PgliteDb } from '../db/pglite.ts';
import { listenApp, listenMetrics, type Listening } from '../http.ts';
import { createLogger } from '../log.ts';
import { seed } from '../seed.ts';
import { startFakeUpstream, type FakeUpstream } from './fakeUpstream.ts';

// ---------- fixtures ----------
let upA: FakeUpstream;
let upB: FakeUpstream;
let upC: FakeUpstream;
let db: PgliteDb;
let gw: Gateway;
let http: Listening;
let metricsSrv: Listening;
let base = '';
let config: ReturnType<typeof loadConfig>;

let adminCookie = '';
let memberCookie = '';
let memberId = '';
let adminId = '';
let memberKey = '';
let memberKeyId = '';
let adminKey = '';
let serverA: { id: string; slug: string };
let serverB: { id: string; slug: string };
let serverC: { id: string; slug: string };
let client: Client;

const text = (r: CallToolResult): string => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('');

async function api(path: string, init: RequestInit & { cookie?: string; json?: unknown } = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.json !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
  const raw = await res.text();
  let body: unknown = raw;
  try {
    body = JSON.parse(raw);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body, headers: res.headers };
}

const cookieOf = (h: Headers): string => h.get('set-cookie')?.split(';')[0] ?? '';

async function lastAudit(): Promise<Record<string, any>> {
  const { rows } = await db.query('select * from audit_log order by id desc limit 1');
  return rows[0] as Record<string, any>;
}

async function connectClient(key: string): Promise<Client> {
  const c = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  const t = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } });
  await c.connect(t, { timeout: 5000 });
  return c;
}

before(async () => {
  upA = await startFakeUpstream(
    'A',
    (s) => {
      s.registerTool('echo', { title: 'Echo', description: 'Echoes text', inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } }, async ({ text }) => ({
        content: [{ type: 'text', text: JSON.stringify({ echoed: text }) }],
        structuredContent: { echoed: text },
      }));
      s.registerTool('get_current_time', { description: 'Time from A' }, async () => ({ content: [{ type: 'text', text: new Date().toISOString() }] }));
    },
    { header: 'authorization', token: 'tokA' },
  );
  upB = await startFakeUpstream(
    'B',
    (s) => {
      s.registerTool('get_current_time', { description: 'Time from B', inputSchema: { timezone: z.string().optional() } }, async () => ({ content: [{ type: 'text', text: 'B-time' }] }));
      s.registerTool('sleep', { description: 'Sleeps', inputSchema: { ms: z.number() } }, async ({ ms }) => {
        await new Promise((r) => setTimeout(r, ms));
        return { content: [{ type: 'text', text: `slept ${ms}` }] };
      });
    },
    { header: 'X-Api-Key', token: 'tokB' },
  );
  upC = await startFakeUpstream('C', (s) => {
    s.registerTool('ping', { description: 'Pong' }, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
  });

  config = loadConfig({
    DATABASE_URL: 'pglite://memory',
    GATEWAY_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
    SESSION_SECRET: 'test-secret',
    PUBLIC_URL: 'http://gateway.test.local',
    ADMIN_EMAIL: 'admin@example.com',
    ADMIN_PASSWORD: 'admin12345',
    LLM_PROVIDER: 'mock',
    ALLOW_PRIVATE_UPSTREAMS: 'true',
    HEALTH_INTERVAL_MS: '600000',
    CONNECT_TIMEOUT_MS: '3000',
    LIST_TOOLS_TIMEOUT_MS: '3000',
    LOG_LEVEL: 'silent',
    PORT: '0',
    METRICS_PORT: '0',
  });
  const log = createLogger('silent');
  db = new PgliteDb();
  await migrate(db, log);
  await seed(db, config, log);
  gw = buildGateway({ config, db, log, defaultMetrics: false });
  await gw.registry.start();
  http = await listenApp(gw.app, 0, '127.0.0.1');
  metricsSrv = await listenMetrics(gw.metrics, 0, '127.0.0.1');
  base = `http://127.0.0.1:${http.port}`;
});

after(async () => {
  await client?.close().catch(() => undefined);
  await Promise.allSettled([http?.close(), metricsSrv?.close(), gw?.registry.stop(), upA?.close(), upB?.close(), upC?.close()]);
  await db?.close();
});

// ---------- tests (sequential, shared state) ----------

test('health endpoints are unauthenticated', async () => {
  assert.equal((await api('/healthz')).status, 200);
  assert.equal((await api('/readyz')).status, 200);
});

test('admin login sets the gw_session cookie', async () => {
  const bad = await api('/api/auth/login', { method: 'POST', json: { email: 'admin@example.com', password: 'nope' } });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error, 'invalid_credentials');
  const r = await api('/api/auth/login', { method: 'POST', json: { email: 'Admin@Example.com', password: 'admin12345' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.role, 'admin');
  adminId = r.body.user.id;
  const sc = r.headers.get('set-cookie') ?? '';
  assert.match(sc, /^gw_session=[0-9a-f-]{36}; /);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Lax/);
  adminCookie = cookieOf(r.headers);
  assert.equal((await api('/api/auth/me', { cookie: adminCookie })).body.user.email, 'admin@example.com');
  assert.equal((await api('/api/auth/me')).status, 401);
});

test('admin creates servers a/b/c; each is probed and connected with tools cached', async () => {
  const a = await api('/api/servers', { method: 'POST', cookie: adminCookie, json: { slug: 'aa', name: 'Server A', url: upA.url, authType: 'bearer', authSecret: 'tokA' } });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(a.body.server.status, 'connected');
  assert.deepEqual(a.body.server.tools.map((t: any) => t.publicName).sort(), ['aa__echo', 'aa__get_current_time']);
  assert.equal(a.body.server.hasCredential, true);
  assert.equal(a.body.server.url, upA.url);
  assert.ok(!('authSecret' in a.body.server) && !JSON.stringify(a.body).includes('tokA'), 'secret never serialised');
  serverA = a.body.server;

  const b = await api('/api/servers', {
    method: 'POST',
    cookie: adminCookie,
    json: { slug: 'bb', name: 'Server B', url: upB.url, authType: 'header', authHeaderName: 'X-Api-Key', authSecret: 'tokB', timeoutMs: 500 },
  });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.equal(b.body.server.status, 'connected');
  assert.equal(b.body.server.timeoutMs, 500);
  serverB = b.body.server;

  const c = await api('/api/servers', { method: 'POST', cookie: adminCookie, json: { slug: 'cc', name: 'Server C', url: upC.url, authType: 'none' } });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.equal(c.body.server.status, 'connected');
  serverC = c.body.server;

  const wrongCred = await api('/api/servers', { method: 'POST', cookie: adminCookie, json: { slug: 'bad', name: 'Bad', url: upA.url, authType: 'bearer', authSecret: 'wrong' } });
  assert.equal(wrongCred.status, 201);
  assert.equal(wrongCred.body.server.status, 'unreachable');
  assert.match(wrongCred.body.server.statusError, /401/);
  assert.equal((await api(`/api/servers/${wrongCred.body.server.id}`, { method: 'DELETE', cookie: adminCookie })).status, 200);

  const dup = await api('/api/servers', { method: 'POST', cookie: adminCookie, json: { slug: 'aa', name: 'dup', url: upA.url, authType: 'none' } });
  assert.equal(dup.status, 409);
  const ssrf = await api('/api/servers', { method: 'POST', cookie: adminCookie, json: { slug: 'meta', name: 'meta', url: 'http://169.254.169.254/latest', authType: 'none' } });
  assert.equal(ssrf.status, 400);
  assert.equal(ssrf.body.error, 'invalid_url');
});

test('invite + accept-invite creates an active member', async () => {
  const inv = await api('/api/users/invite', { method: 'POST', cookie: adminCookie, json: { email: 'member@example.com', role: 'member' } });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  assert.equal(inv.body.user.status, 'invited');
  assert.match(inv.body.inviteUrl, /^http:\/\/gateway\.test\.local\/invite\/[A-Za-z0-9_-]+$/);
  const token = decodeURIComponent(new URL(inv.body.inviteUrl).pathname.split('/').pop()!);
  const noLogin = await api('/api/auth/login', { method: 'POST', json: { email: 'member@example.com', password: 'member12345' } });
  assert.equal(noLogin.status, 401, 'invited users cannot log in yet');
  const acc = await api('/api/auth/accept-invite', { method: 'POST', json: { token, name: 'Member', password: 'member12345' } });
  assert.equal(acc.status, 200, JSON.stringify(acc.body));
  assert.equal(acc.body.user.status, 'active');
  memberId = acc.body.user.id;
  memberCookie = cookieOf(acc.headers);
  const again = await api('/api/auth/accept-invite', { method: 'POST', json: { token, name: 'x', password: 'member12345' } });
  assert.equal(again.status, 400, 'single use');
  assert.equal((await api('/api/users', { cookie: memberCookie })).status, 403, 'admin-only');
});

test('member creates an API key (plaintext shown once)', async () => {
  const k = await api('/api/keys', { method: 'POST', cookie: memberCookie, json: { name: 'laptop' } });
  assert.equal(k.status, 201);
  assert.match(k.body.plaintext, /^gw_[a-z0-9]{8}_[A-Za-z0-9_-]{32}$/);
  assert.equal(k.body.key.prefix, k.body.plaintext.slice(0, 11));
  assert.equal(k.body.key.userId, memberId);
  memberKey = k.body.plaintext;
  memberKeyId = k.body.key.id;
  const list = await api('/api/keys', { cookie: memberCookie });
  assert.equal(list.body.keys.length, 1);
  assert.ok(!JSON.stringify(list.body).includes(memberKey));
  const ak = await api(`/api/users/${adminId}/keys`, { method: 'POST', cookie: adminCookie, json: { name: 'admin key' } });
  assert.equal(ak.status, 201);
  adminKey = ak.body.plaintext;
});

test('SDK client lists public tools through the gateway', async () => {
  client = await connectClient(memberKey);
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ['aa__echo', 'aa__get_current_time', 'bb__get_current_time', 'bb__sleep', 'cc__ping'],
  );
  const echo = tools.find((t) => t.name === 'aa__echo')!;
  assert.equal(echo.description, '[Server A] Echoes text');
  assert.equal(echo.title, 'Echo');
  assert.equal(echo.annotations?.readOnlyHint, true);
  assert.equal(echo.inputSchema.type, 'object');
  assert.ok((echo.inputSchema.properties as any).text);
  const viaApi = await api('/api/tools', { cookie: memberCookie });
  assert.deepEqual(viaApi.body.tools.map((t: any) => t.publicName).sort(), tools.map((t) => t.name).sort());
});

test('aa__echo succeeds and writes an audit row attributed to the member and key', async () => {
  const r = (await client.callTool({ name: 'aa__echo', arguments: { text: 'hi' } })) as CallToolResult;
  assert.ok(!r.isError);
  assert.equal(text(r), '{"echoed":"hi"}');
  assert.deepEqual(r.structuredContent, { echoed: 'hi' });
  const row = await lastAudit();
  assert.equal(row.outcome, 'success');
  assert.equal(row.user_id, memberId);
  assert.equal(row.user_email, 'member@example.com');
  assert.equal(row.source, 'mcp');
  assert.equal(row.api_key_id, memberKeyId);
  assert.equal(row.server_id, serverA.id);
  assert.equal(row.server_slug, 'aa');
  assert.equal(row.tool_name, 'echo');
  assert.equal(row.public_tool_name, 'aa__echo');
  assert.equal(row.args_preview, '{"text":"hi"}');
  assert.ok(row.result_bytes > 0);
});

test('bb__sleep exceeds the 500 ms server timeout → isError "timed out" + audit timeout', async () => {
  const started = Date.now();
  const r = (await client.callTool({ name: 'bb__sleep', arguments: { ms: 3000 } })) as CallToolResult;
  assert.ok(Date.now() - started < 2500, 'returned before the upstream finished');
  assert.equal(r.isError, true);
  assert.match(text(r), /Upstream "bb" timed out after 500 ms/);
  const row = await lastAudit();
  assert.equal(row.outcome, 'timeout');
  assert.equal(row.public_tool_name, 'bb__sleep');
});

test('stopping C → unreachable call, /refresh shows unreachable, A still works', async () => {
  const ok = (await client.callTool({ name: 'cc__ping', arguments: {} })) as CallToolResult;
  assert.equal(text(ok), 'pong');
  await upC.close();
  const r = (await client.callTool({ name: 'cc__ping', arguments: {} })) as CallToolResult;
  assert.equal(r.isError, true);
  assert.match(text(r), /Upstream "cc" is unreachable: /);
  assert.equal((await lastAudit()).outcome, 'unreachable');

  const ref = await api(`/api/servers/${serverC.id}/refresh`, { method: 'POST', cookie: adminCookie });
  assert.equal(ref.status, 200);
  assert.equal(ref.body.server.status, 'unreachable');
  assert.ok(ref.body.server.statusError, 'statusError set');
  assert.equal(ref.body.server.tools.length, 1, 'cached tool list kept');

  const a = (await client.callTool({ name: 'aa__echo', arguments: { text: 'still' } })) as CallToolResult;
  assert.equal(text(a), '{"echoed":"still"}');
  const list = await client.listTools();
  assert.ok(list.tools.some((t) => t.name === 'cc__ping'), 'unreachable servers keep their cached tools listed');
});

test('chat with the mock provider streams tool_call / tool_result / done and audits source=chat', async () => {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: memberCookie },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'call aa__echo {"text":"hi"}' }] }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  const raw = await res.text();
  const events = raw
    .split('\n\n')
    .filter(Boolean)
    .map((chunk) => {
      const ev = /^event: (.+)$/m.exec(chunk)?.[1];
      const data = /^data: (.+)$/m.exec(chunk)?.[1];
      return { event: ev, data: data ? JSON.parse(data) : undefined };
    });
  const names = events.map((e) => e.event);
  assert.deepEqual(names, ['start', 'tool_call', 'tool_result', 'text', 'done']);
  assert.equal(events[0]?.data.provider, 'mock');
  assert.equal(events[0]?.data.toolCount, 5);
  assert.equal(events[1]?.data.publicName, 'aa__echo');
  assert.equal(events[1]?.data.serverSlug, 'aa');
  assert.deepEqual(events[1]?.data.args, { text: 'hi' });
  assert.equal(events[2]?.data.outcome, 'success');
  assert.equal(events[2]?.data.preview, '{"echoed":"hi"}');
  assert.match(events[4]?.data.message, /^Called aa__echo: /);
  assert.equal(events[4]?.data.toolCalls.length, 1);
  const row = await lastAudit();
  assert.equal(row.source, 'chat');
  assert.equal(row.user_id, memberId);
  assert.equal(row.api_key_id, null);
  assert.equal(row.outcome, 'success');
});

test('denylist policy hides aa__echo from members and rejects calls with denied', async () => {
  const p = await api(`/api/servers/${serverA.id}`, { method: 'PATCH', cookie: adminCookie, json: { memberToolPolicy: { mode: 'denylist', patterns: ['echo'] } } });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.server.status, 'connected');
  assert.equal(p.body.server.tools.find((t: any) => t.name === 'echo').allowedForMembers, false);

  const { tools } = await client.listTools();
  assert.ok(!tools.some((t) => t.name === 'aa__echo'));
  assert.ok(tools.some((t) => t.name === 'aa__get_current_time'));
  await assert.rejects(client.callTool({ name: 'aa__echo', arguments: { text: 'x' } }), (e) => e instanceof McpError && e.code === -32602 && e.message === 'MCP error -32602: Tool not permitted for your role');
  assert.equal((await lastAudit()).outcome, 'denied');
  await assert.rejects(client.callTool({ name: 'nope__nothing', arguments: {} }), (e) => e instanceof McpError && e.code === -32602 && /Unknown tool/.test(e.message));
  assert.equal((await lastAudit()).outcome, 'not_found');

  const memberView = await api(`/api/servers/${serverA.id}`, { cookie: memberCookie });
  assert.ok(!memberView.body.server.tools.some((t: any) => t.name === 'echo'), 'member server view filters tools');
});

test('disabling b removes its tools and calls are denied', async () => {
  const p = await api(`/api/servers/${serverB.id}`, { method: 'PATCH', cookie: adminCookie, json: { enabled: false } });
  assert.equal(p.status, 200);
  assert.equal(p.body.server.status, 'disabled');
  const { tools } = await client.listTools();
  assert.ok(!tools.some((t) => t.name.startsWith('bb__')));
  await assert.rejects(client.callTool({ name: 'bb__get_current_time', arguments: {} }), (e) => e instanceof McpError && /Server bb is disabled/.test(e.message));
  assert.equal((await lastAudit()).outcome, 'denied');
});

test('member GET /api/servers hides url and auth details; audit shows only own rows', async () => {
  const adminClient = await connectClient(adminKey);
  await adminClient.callTool({ name: 'aa__get_current_time', arguments: {} });
  await adminClient.close();

  const s = await api('/api/servers', { cookie: memberCookie });
  assert.equal(s.status, 200);
  for (const srv of s.body.servers) {
    assert.ok(!('url' in srv), 'no url for members');
    assert.ok(!('authHeaderName' in srv));
    assert.ok(!('authSecret' in srv) && !('authSecretEnc' in srv));
  }
  const adminS = await api('/api/servers', { cookie: adminCookie });
  assert.ok(adminS.body.servers.every((srv: any) => typeof srv.url === 'string'));

  const mine = await api('/api/audit?limit=100', { cookie: memberCookie });
  assert.equal(mine.status, 200);
  assert.ok(mine.body.entries.length >= 6);
  assert.ok(mine.body.entries.every((e: any) => e.userId === memberId));
  const all = await api('/api/audit?limit=100', { cookie: adminCookie });
  assert.ok(all.body.entries.some((e: any) => e.userId === adminId));
  assert.ok(all.body.entries.some((e: any) => e.source === 'chat'));
  const filtered = await api(`/api/audit?outcome=timeout`, { cookie: adminCookie });
  assert.ok(filtered.body.entries.length >= 1 && filtered.body.entries.every((e: any) => e.outcome === 'timeout'));
});

test('wrong key → 401 with RFC 6750 WWW-Authenticate; Origin check → 403; discovery paths → 404', async () => {
  const wrong = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer gw_abcdefgh_000000000000000000000000000000ab' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(wrong.status, 401);
  assert.match(wrong.headers.get('www-authenticate') ?? '', /^Bearer error="invalid_token", error_description="[^"]+"$/);
  assert.ok(!/resource_metadata/.test(wrong.headers.get('www-authenticate') ?? ''));
  assert.deepEqual(await wrong.json(), { error: 'invalid_token', error_description: 'Unknown API key' });

  const query = await fetch(`${base}/mcp?api_key=${memberKey}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
  assert.equal(query.status, 401, 'keys in the query string are never accepted');

  const origin = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example', 'x-api-key': memberKey }, body: '{}' });
  assert.equal(origin.status, 403);
  const goodOrigin = await fetch(`${base}/mcp`, { method: 'GET', headers: { origin: 'http://gateway.test.local' } });
  assert.equal(goodOrigin.status, 405);
  // Browser-based MCP clients (Inspector web UI) are allowed by default via MCP_ALLOWED_ORIGINS.
  const inspectorOrigin = await fetch(`${base}/mcp`, { method: 'GET', headers: { origin: 'http://127.0.0.1:6274' } });
  assert.equal(inspectorOrigin.status, 405);
  assert.equal((await fetch(`${base}/mcp`, { method: 'DELETE' })).status, 405);
  for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server', '/.well-known/openid-configuration', '/register', '/authorize', '/token']) {
    const r = await fetch(`${base}${p}`);
    assert.equal(r.status, 404, p);
    assert.match(r.headers.get('content-type') ?? '', /json/);
  }
});

test('revoking the key makes the next MCP request fail with 401', async () => {
  const del = await api(`/api/keys/${memberKeyId}`, { method: 'DELETE', cookie: memberCookie });
  assert.equal(del.status, 200);
  await assert.rejects(client.callTool({ name: 'aa__get_current_time', arguments: {} }), (e) => e instanceof StreamableHTTPError && e.code === 401);
  await assert.rejects(connectClient(memberKey), (e) => e instanceof StreamableHTTPError && e.code === 401 && /revoked/.test(e.message));
  const keys = await api('/api/keys', { cookie: memberCookie });
  assert.ok(keys.body.keys[0].revokedAt);
});

test('disabled user cannot use sessions or keys; cannot delete self', async () => {
  const self = await api(`/api/users/${adminId}`, { method: 'DELETE', cookie: adminCookie });
  assert.equal(self.status, 400);
  const dis = await api(`/api/users/${memberId}`, { method: 'PATCH', cookie: adminCookie, json: { status: 'disabled' } });
  assert.equal(dis.status, 200);
  assert.equal((await api('/api/auth/me', { cookie: memberCookie })).status, 401);
  const k2 = await api(`/api/users/${memberId}/keys`, { method: 'POST', cookie: adminCookie, json: { name: 'k2' } });
  await assert.rejects(connectClient(k2.body.plaintext), (e) => e instanceof StreamableHTTPError && e.code === 401 && /disabled/.test(e.message));
});

test('/metrics exposes gateway_tool_calls_total and upstream gauges', async () => {
  const res = await fetch(`http://127.0.0.1:${metricsSrv.port}/metrics`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /gateway_tool_calls_total\{server="aa",tool="echo",outcome="success",source="mcp"\} \d+/);
  assert.match(body, /gateway_tool_calls_total\{[^}]*outcome="timeout"[^}]*\} 1/);
  assert.match(body, /gateway_upstream_up\{server="aa"\} 1/);
  assert.match(body, /gateway_upstream_up\{server="bb"\} 0/);
  assert.match(body, /gateway_tool_call_duration_seconds_bucket/);
  assert.match(body, /gateway_http_requests_total\{route="\/api\/auth\/login"/);
});

test('chat is disabled (503) when the provider is none', async () => {
  const none = buildGateway({ config: { ...config, llm: { provider: 'none', model: 'x' } }, db, log: createLogger('silent'), defaultMetrics: false });
  const srv = await listenApp(none.app, 0, '127.0.0.1');
  try {
    const r = await fetch(`http://127.0.0.1:${srv.port}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: adminCookie }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(r.status, 503);
    assert.equal(((await r.json()) as any).error, 'chat_disabled');
    const cfg = (await (await fetch(`http://127.0.0.1:${srv.port}/api/config`)).json()) as any;
    assert.equal(cfg.chat.enabled, false);
  } finally {
    await srv.close();
  }
});
