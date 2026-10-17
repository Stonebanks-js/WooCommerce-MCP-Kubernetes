import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireAdmin, requireSession } from '../auth/middleware.ts';
import { isUuid } from '../auth/users.ts';
import type { Config } from '../config.ts';
import { newId } from '../crypto/random.ts';
import { encryptSecret } from '../crypto/secretbox.ts';
import type { Db } from '../db/db.ts';
import { SLUG_RE } from '../upstream/naming.ts';
import { memberToolPolicySchema } from '../upstream/policy.ts';
import type { UpstreamRegistry } from '../upstream/registry.ts';
import { UpstreamUrlError, validateUpstreamUrl } from '../upstream/ssrf.ts';
import { ApiError, notFound, parseBody, wrap } from './errors.ts';
import { toServerDto } from './serialize.ts';

const serverInputSchema = z.object({
  slug: z.string().regex(SLUG_RE, 'slug must match ^[a-z][a-z0-9-]{1,19}$'),
  name: z.string().trim().min(1).max(100),
  url: z.string().trim().min(1).max(2000),
  enabled: z.boolean().optional(),
  authType: z.enum(['none', 'bearer', 'header']),
  authHeaderName: z.string().trim().regex(/^[A-Za-z0-9-]{1,64}$/, 'invalid header name').optional(),
  authSecret: z.string().max(4000).optional(),
  timeoutMs: z.number().int().min(100).max(600_000).optional(),
  memberToolPolicy: memberToolPolicySchema.optional(),
});
const serverPatchSchema = serverInputSchema.partial();

export function serversRouter(db: Db, config: Config, registry: UpstreamRegistry): Router {
  const r = Router();
  const ssrf = { allowPrivate: config.allowPrivateUpstreams, allowedSuffixes: config.allowedInternalSuffixes };

  async function checkUrl(url: string): Promise<string> {
    try {
      return (await validateUpstreamUrl(url, ssrf)).toString();
    } catch (err) {
      if (err instanceof UpstreamUrlError) throw new ApiError(400, 'invalid_url', err.message);
      throw err;
    }
  }

  function lookup(id: string) {
    if (!isUuid(id)) throw notFound('Server');
    const rec = registry.get(id);
    if (!rec) throw notFound('Server');
    return rec;
  }

  r.get('/', requireSession, (req, res) => {
    const user = currentUser(req);
    res.json({ servers: registry.snapshot().map((s) => toServerDto(s, user)) });
  });

  r.post(
    '/',
    requireAdmin,
    wrap(async (req, res) => {
      const input = parseBody(serverInputSchema, req.body);
      if (input.authType === 'header' && !input.authHeaderName) throw new ApiError(400, 'validation_error', 'authHeaderName is required for authType=header');
      const url = await checkUrl(input.url);
      if (registry.getBySlug(input.slug)) throw new ApiError(409, 'slug_exists', `A server with slug "${input.slug}" already exists`);
      const id = newId();
      const secretEnc = input.authType !== 'none' && input.authSecret ? encryptSecret(input.authSecret, config.encryptionKey) : null;
      await db.query(
        `insert into mcp_servers (id, slug, name, url, enabled, auth_type, auth_header_name, auth_secret_enc, timeout_ms, member_tool_policy, managed_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'admin')`,
        [
          id,
          input.slug,
          input.name,
          url,
          input.enabled ?? true,
          input.authType,
          input.authType === 'header' ? input.authHeaderName : null,
          secretEnc,
          input.timeoutMs ?? config.defaultToolTimeoutMs,
          JSON.stringify(input.memberToolPolicy ?? { mode: 'all' }),
        ],
      );
      await registry.reload();
      const rec = (await registry.probe(id)) ?? registry.get(id);
      if (!rec) throw new ApiError(500, 'internal_error', 'server vanished after insert');
      res.status(201).json({ server: toServerDto(rec, currentUser(req)) });
    }),
  );

  r.get('/:id', requireSession, (req, res) => {
    res.json({ server: toServerDto(lookup(req.params.id as string), currentUser(req)) });
  });

  r.patch(
    '/:id',
    requireAdmin,
    wrap(async (req, res) => {
      const rec = lookup(req.params.id as string);
      const input = parseBody(serverPatchSchema, req.body);
      const authType = input.authType ?? rec.authType;
      const headerName = input.authHeaderName ?? rec.authHeaderName;
      if (authType === 'header' && !headerName) throw new ApiError(400, 'validation_error', 'authHeaderName is required for authType=header');
      if (input.slug && input.slug !== rec.slug && registry.getBySlug(input.slug)) throw new ApiError(409, 'slug_exists', `A server with slug "${input.slug}" already exists`);
      const url = input.url !== undefined ? await checkUrl(input.url) : rec.url;

      const sets: string[] = ['updated_at = now()'];
      const params: unknown[] = [rec.id];
      const set = (col: string, v: unknown, cast = '') => {
        params.push(v);
        sets.push(`${col} = $${params.length}${cast}`);
      };
      if (input.slug !== undefined) set('slug', input.slug);
      if (input.name !== undefined) set('name', input.name);
      if (input.url !== undefined) set('url', url);
      if (input.enabled !== undefined) set('enabled', input.enabled);
      if (input.authType !== undefined) set('auth_type', input.authType);
      set('auth_header_name', authType === 'header' ? headerName : null);
      if (input.timeoutMs !== undefined) set('timeout_ms', input.timeoutMs);
      if (input.memberToolPolicy !== undefined) set('member_tool_policy', JSON.stringify(input.memberToolPolicy), '::jsonb');
      // authSecret omitted = unchanged, "" = cleared; switching to authType=none also clears it.
      if (authType === 'none') set('auth_secret_enc', null);
      else if (input.authSecret !== undefined) set('auth_secret_enc', input.authSecret === '' ? null : encryptSecret(input.authSecret, config.encryptionKey));
      await db.query(`update mcp_servers set ${sets.join(', ')} where id = $1`, params);
      await registry.reload();
      const fresh = (await registry.probe(rec.id)) ?? registry.get(rec.id);
      if (!fresh) throw notFound('Server');
      res.json({ server: toServerDto(fresh, currentUser(req)) });
    }),
  );

  r.delete(
    '/:id',
    requireAdmin,
    wrap(async (req, res) => {
      const rec = lookup(req.params.id as string);
      await db.query('delete from mcp_servers where id = $1', [rec.id]);
      await registry.reload();
      res.json({ ok: true });
    }),
  );

  r.post(
    '/:id/refresh',
    requireAdmin,
    wrap(async (req, res) => {
      const rec = lookup(req.params.id as string);
      await registry.reload();
      const fresh = (await registry.probe(rec.id)) ?? registry.get(rec.id);
      if (!fresh) throw notFound('Server');
      res.json({ server: toServerDto(fresh, currentUser(req)) });
    }),
  );

  return r;
}
