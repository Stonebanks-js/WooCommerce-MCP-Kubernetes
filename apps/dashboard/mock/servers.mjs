// /api/servers and /api/tools handlers.
import { newId, probeTools, servers } from './data.mjs';
import { allowedForMembers, fail, json, SLUG } from './http.mjs';

const now = () => new Date().toISOString();

function toolView(server, t) {
  return {
    name: t.name, publicName: `${server.slug}__${t.name}`, title: t.title, description: t.description,
    allowedForMembers: allowedForMembers(server.memberToolPolicy, t.name), annotations: t.annotations,
  };
}

/** Members never see url / auth fields and only policy-allowed tools (contracts.md §9). */
export function serializeServer(s, user) {
  const tools = s.rawTools.map((t) => toolView(s, t)).filter((t) => user.role === 'admin' || t.allowedForMembers);
  const base = {
    id: s.id, slug: s.slug, name: s.name, enabled: s.enabled, hasCredential: s.hasCredential, authType: s.authType,
    timeoutMs: s.timeoutMs, memberToolPolicy: s.memberToolPolicy, managedBy: s.managedBy,
    status: s.status, statusError: s.statusError, statusCheckedAt: s.statusCheckedAt, toolsUpdatedAt: s.toolsUpdatedAt,
    tools, createdAt: s.createdAt, updatedAt: s.updatedAt,
  };
  if (user.role === 'admin') {
    base.url = s.url;
    base.authHeaderName = s.authHeaderName;
  }
  return base;
}

/** Fake probe: disabled → disabled; URLs containing "unreachable" (or the seeded notes server) fail. */
function probe(s) {
  s.statusCheckedAt = now();
  if (!s.enabled) {
    s.status = 'disabled';
    s.statusError = undefined;
    return;
  }
  if (/unreachable|bad|down/i.test(s.url) || s.slug === 'notes') {
    s.status = 'unreachable';
    s.statusError = `connect ECONNREFUSED ${new URL(s.url).host} (initialize timed out after 5000 ms)`;
    return;
  }
  s.status = 'connected';
  s.statusError = undefined;
  if (s.rawTools.length === 0) s.rawTools = probeTools;
  s.toolsUpdatedAt = s.statusCheckedAt;
}

export function listServers({ res, user }) {
  json(res, 200, { servers: servers.map((s) => serializeServer(s, user)) });
}

export function getServer({ res, user, params }) {
  const s = servers.find((x) => x.id === params.id);
  if (!s) return fail(res, 404, 'not_found', 'Server not found');
  json(res, 200, { server: serializeServer(s, user) });
}

function validate(body, existing) {
  if (!existing || body.slug !== undefined) {
    if (typeof body.slug !== 'string' || !SLUG.test(body.slug)) return 'slug must match ^[a-z][a-z0-9-]{1,19}$';
    if (servers.some((s) => s.slug === body.slug && s !== existing)) return `A server with slug "${body.slug}" already exists`;
  }
  if (!existing || body.name !== undefined) if (typeof body.name !== 'string' || body.name.trim() === '') return 'name is required';
  if (!existing || body.url !== undefined) if (typeof body.url !== 'string' || !/^https?:\/\//.test(body.url)) return 'url must be an http(s) URL';
  if (!existing || body.authType !== undefined) if (!['none', 'bearer', 'header'].includes(body.authType)) return 'authType must be none, bearer or header';
  if (body.authType === 'header' && !body.authHeaderName) return 'authHeaderName is required for header auth';
  return null;
}

function apply(s, body) {
  for (const k of ['slug', 'name', 'url', 'authType', 'timeoutMs', 'memberToolPolicy']) if (body[k] !== undefined) s[k] = body[k];
  if (body.enabled !== undefined) s.enabled = Boolean(body.enabled);
  if (body.authType !== undefined) s.authHeaderName = body.authType === 'header' ? body.authHeaderName : undefined;
  else if (body.authHeaderName !== undefined) s.authHeaderName = body.authHeaderName;
  if (body.authSecret !== undefined) s.hasCredential = body.authSecret !== '';
  if (s.authType === 'none') s.hasCredential = false;
  s.updatedAt = now();
}

export async function createServer({ res, user, body }) {
  const problem = validate(body, null);
  if (problem) return fail(res, 400, 'validation', problem);
  const s = {
    id: newId(), slug: '', name: '', url: '', enabled: true, authType: 'none', authHeaderName: undefined, hasCredential: false,
    timeoutMs: 30000, memberToolPolicy: { mode: 'all' }, managedBy: 'admin', status: 'unreachable', statusError: undefined,
    statusCheckedAt: undefined, toolsUpdatedAt: undefined, rawTools: [], createdAt: now(), updatedAt: now(),
  };
  apply(s, body);
  await new Promise((r) => setTimeout(r, 400)); // the real gateway probes before answering
  probe(s);
  servers.push(s);
  json(res, 201, { server: serializeServer(s, user) });
}

export async function patchServer({ res, user, params, body }) {
  const s = servers.find((x) => x.id === params.id);
  if (!s) return fail(res, 404, 'not_found', 'Server not found');
  const problem = validate(body, s);
  if (problem) return fail(res, 400, 'validation', problem);
  apply(s, body);
  await new Promise((r) => setTimeout(r, 300));
  probe(s);
  json(res, 200, { server: serializeServer(s, user) });
}

export function deleteServer({ res, params }) {
  const i = servers.findIndex((x) => x.id === params.id);
  if (i === -1) return fail(res, 404, 'not_found', 'Server not found');
  servers.splice(i, 1);
  json(res, 200, { ok: true });
}

export async function refreshServer({ res, user, params }) {
  const s = servers.find((x) => x.id === params.id);
  if (!s) return fail(res, 404, 'not_found', 'Server not found');
  await new Promise((r) => setTimeout(r, 500));
  probe(s);
  json(res, 200, { server: serializeServer(s, user) });
}

/** Exactly what this user sees over MCP: enabled servers, member policy applied. */
export function visibleTools(user) {
  const out = [];
  for (const s of servers) {
    if (!s.enabled) continue;
    for (const t of s.rawTools) {
      if (user.role !== 'admin' && !allowedForMembers(s.memberToolPolicy, t.name)) continue;
      out.push({
        publicName: `${s.slug}__${t.name}`, serverSlug: s.slug, serverName: s.name, name: t.name, title: t.title,
        description: `[${s.name}] ${t.description}`, inputSchema: t.inputSchema, annotations: t.annotations,
      });
    }
  }
  return out;
}

export function listTools({ res, user }) {
  json(res, 200, { tools: visibleTools(user) });
}
