// Tiny helpers shared by the mock server modules.

export function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function fail(res, status, code, message) {
  json(res, status, { error: code, message });
}

export function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      if (data.trim() === '') return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('Request body is not valid JSON')); }
    });
    req.on('error', reject);
  });
}

export function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, createdAt: u.createdAt });

/** Glob with `*` only, anchored, as in contracts.md §9 MemberToolPolicy. */
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function matchGlob(pattern, name) {
  const re = new RegExp('^' + pattern.split('*').map(escapeRegExp).join('.*') + '$');
  return re.test(name);
}

export function allowedForMembers(policy, toolName) {
  if (!policy || policy.mode === 'all') return true;
  const hit = (policy.patterns ?? []).some((p) => matchGlob(p, toolName));
  return policy.mode === 'allowlist' ? hit : !hit;
}

export const SLUG = /^[a-z][a-z0-9-]{1,19}$/;
