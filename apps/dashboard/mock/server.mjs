// Mock gateway for `npm run dev:mock`: implements every REST route of contracts.md §9 plus the SSE
// chat stream of §11 against in-memory fixtures, on the same port (8080) the Vite proxy targets.
//
//   admin@example.com  / admin123   (admin)
//   member@example.com / member123  (member)
//
// Everything resets when the process restarts. Set CHAT_ENABLED=false to exercise the disabled
// notice, PORT to change the port and PUBLIC_URL to change the host used in invite links.
import { createServer } from 'node:http';
import { streamChat } from './chat.mjs';
import { sessions, users } from './data.mjs';
import { cookies, fail, json, readJson } from './http.mjs';
import {
  createServer as createMcpServer, deleteServer, getServer, listServers, listTools, patchServer, refreshServer, visibleTools,
} from './servers.mjs';
import {
  acceptInvite, createMyKey, createUserKey, deleteUser, inviteUser, listAudit, listMyKeys, listUserKeys, listUsers, login,
  logout, me, patchUser, revokeKey,
} from './users.mjs';

const PORT = Number(process.env.PORT ?? 8080);
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;
const CHAT_ENABLED = process.env.CHAT_ENABLED !== 'false';
const VERSION = '0.1.0-mock';

const config = () => ({
  publicUrl: PUBLIC_URL,
  mcpUrl: `${PUBLIC_URL}/mcp`,
  chat: CHAT_ENABLED ? { enabled: true, provider: 'mock', model: 'mock-model-1' } : { enabled: false, provider: 'none', model: '' },
  version: VERSION,
});

/** who: 'anyone' | 'session' | 'admin'. Handlers receive {req,res,user,sessionId,params,query,body}. */
const ROUTES = [
  ['POST', /^\/api\/auth\/login$/, 'anyone', login],
  ['POST', /^\/api\/auth\/logout$/, 'session', logout],
  ['GET', /^\/api\/auth\/me$/, 'session', me],
  ['POST', /^\/api\/auth\/accept-invite$/, 'anyone', acceptInvite],
  ['GET', /^\/api\/config$/, 'anyone', ({ res }) => json(res, 200, config())],
  ['GET', /^\/api\/servers$/, 'session', listServers],
  ['POST', /^\/api\/servers$/, 'admin', createMcpServer],
  ['GET', /^\/api\/servers\/(?<id>[^/]+)$/, 'session', getServer],
  ['PATCH', /^\/api\/servers\/(?<id>[^/]+)$/, 'admin', patchServer],
  ['DELETE', /^\/api\/servers\/(?<id>[^/]+)$/, 'admin', deleteServer],
  ['POST', /^\/api\/servers\/(?<id>[^/]+)\/refresh$/, 'admin', refreshServer],
  ['GET', /^\/api\/tools$/, 'session', listTools],
  ['GET', /^\/api\/users$/, 'admin', listUsers],
  ['POST', /^\/api\/users\/invite$/, 'admin', inviteUser],
  ['PATCH', /^\/api\/users\/(?<id>[^/]+)$/, 'admin', patchUser],
  ['DELETE', /^\/api\/users\/(?<id>[^/]+)$/, 'admin', deleteUser],
  ['GET', /^\/api\/users\/(?<id>[^/]+)\/keys$/, 'admin', listUserKeys],
  ['POST', /^\/api\/users\/(?<id>[^/]+)\/keys$/, 'admin', createUserKey],
  ['GET', /^\/api\/keys$/, 'session', listMyKeys],
  ['POST', /^\/api\/keys$/, 'session', createMyKey],
  ['DELETE', /^\/api\/keys\/(?<id>[^/]+)$/, 'session', revokeKey],
  ['GET', /^\/api\/audit$/, 'session', listAudit],
  ['POST', /^\/api\/chat$/, 'session', chat],
  ['GET', /^\/healthz$/, 'anyone', ({ res }) => json(res, 200, { ok: true })],
  ['GET', /^\/readyz$/, 'anyone', ({ res }) => json(res, 200, { ok: true })],
];

async function chat({ req, res, user, body }) {
  if (!CHAT_ENABLED) return fail(res, 400, 'chat_disabled', 'No LLM provider is configured');
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || messages.some((m) => !['user', 'assistant'].includes(m?.role) || typeof m?.content !== 'string')) {
    return fail(res, 400, 'validation', 'messages must be an array of {role, content}');
  }
  await streamChat(req, res, user, messages, visibleTools(user));
}

function resolveUser(req) {
  const sessionId = cookies(req).gw_session;
  const userId = sessionId ? sessions.get(sessionId) : undefined;
  const user = userId ? users.find((u) => u.id === userId) : undefined;
  if (user && user.status === 'active') return { sessionId, user };
  return { sessionId, user: null };
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const started = Date.now();
  res.on('finish', () => {
    console.log(JSON.stringify({ level: 'info', method: req.method, path: url.pathname, status: res.statusCode, ms: Date.now() - started }));
  });

  // Mirrors the gateway's "mcp endpoint exists" surface so the connect snippets point somewhere.
  if (url.pathname === '/mcp') {
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Bearer error="invalid_token", error_description="mock gateway: use the real gateway for MCP"',
    });
    return res.end(JSON.stringify({ error: 'invalid_token', error_description: 'mock gateway: use the real gateway for MCP' }));
  }

  for (const [method, pattern, who, handler] of ROUTES) {
    const match = pattern.exec(url.pathname);
    if (!match) continue;
    if (req.method !== method) continue;
    const { sessionId, user } = resolveUser(req);
    if (who !== 'anyone' && !user) return fail(res, 401, 'unauthorized', 'Sign in to continue');
    if (who === 'admin' && user.role !== 'admin') return fail(res, 403, 'forbidden', 'Administrators only');
    let body = {};
    if (method === 'POST' || method === 'PATCH') {
      try { body = await readJson(req); } catch (err) { return fail(res, 400, 'bad_json', err.message); }
    }
    try {
      await handler({ req, res, user, sessionId, params: match.groups ?? {}, query: url.searchParams, body });
    } catch (err) {
      console.error(err);
      if (!res.headersSent) fail(res, 500, 'internal', err?.message ?? 'Internal error');
      else res.end();
    }
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    const known = ROUTES.some(([, pattern]) => pattern.test(url.pathname));
    return fail(res, known ? 405 : 404, known ? 'method_not_allowed' : 'not_found', known ? `${req.method} not allowed here` : 'No such route');
  }
  fail(res, 404, 'not_found', 'The mock gateway only serves /api, /mcp, /healthz and /readyz; run `npm run dev` for the UI');
}

const server = createServer((req, res) => { void handle(req, res); });
server.listen(PORT, () => {
  console.log(`mock gateway listening on http://localhost:${PORT}  (chat ${CHAT_ENABLED ? 'enabled' : 'disabled'})`);
  console.log('  admin@example.com / admin123   member@example.com / member123');
});
