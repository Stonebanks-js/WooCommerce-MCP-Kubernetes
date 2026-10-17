import { z } from 'zod';
import type { Config } from './config.ts';
import { hashPassword } from './crypto/password.ts';
import { newId } from './crypto/random.ts';
import { encryptSecret } from './crypto/secretbox.ts';
import type { Db } from './db/db.ts';
import type { Logger } from './log.ts';
import { SLUG_RE } from './upstream/naming.ts';
import { memberToolPolicySchema } from './upstream/policy.ts';

const seedServerSchema = z.object({
  slug: z.string().regex(SLUG_RE),
  name: z.string().min(1).max(100),
  url: z.string().url(),
  enabled: z.boolean().optional(),
  authType: z.enum(['none', 'bearer', 'header']).default('none'),
  authHeaderName: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).optional(),
  authSecretEnv: z.string().optional(),
  authSecret: z.string().optional(),
  timeoutMs: z.number().int().min(100).max(600_000).optional(),
  memberToolPolicy: memberToolPolicySchema.optional(),
});

export type SeedServer = z.infer<typeof seedServerSchema>;

export function parseSeedServers(json: string): SeedServer[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json || '[]');
  } catch {
    throw new Error('SEED_SERVERS_JSON is not valid JSON');
  }
  const r = z.array(seedServerSchema).safeParse(raw);
  if (!r.success) throw new Error(`SEED_SERVERS_JSON invalid: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return r.data;
}

async function ensureUser(db: Db, log: Logger, email: string, password: string, role: 'admin' | 'member', name: string, onlyIfNoRole: boolean): Promise<void> {
  if (onlyIfNoRole) {
    const { rows } = await db.query<{ n: number | string }>('select count(*)::int as n from users where role = $1', [role]);
    if (Number(rows[0]?.n ?? 0) > 0) return;
  }
  const exists = await db.query('select 1 from users where email = $1', [email]);
  if (exists.rows.length > 0) return;
  await db.query(`insert into users (id, email, name, role, status, password_hash) values ($1,$2,$3,$4,'active',$5)`, [newId(), email, name, role, await hashPassword(password)]);
  log.info({ email, role }, 'seeded user');
}

/** Contracts §8: admin only when no admin exists; demo member likewise; seed servers only when the slug is new. */
export async function seed(db: Db, config: Config, log: Logger, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await ensureUser(db, log, config.adminEmail, config.adminPassword, 'admin', 'Admin', true);
  if (config.demoMemberEmail && config.demoMemberPassword) {
    await ensureUser(db, log, config.demoMemberEmail, config.demoMemberPassword, 'member', 'Demo member', false);
  }
  for (const s of parseSeedServers(config.seedServersJson)) {
    const exists = await db.query('select 1 from mcp_servers where slug = $1', [s.slug]);
    if (exists.rows.length > 0) continue;
    const secret = s.authSecret ?? (s.authSecretEnv ? env[s.authSecretEnv] : undefined);
    if (s.authType !== 'none' && !secret) log.warn({ slug: s.slug, env: s.authSecretEnv }, 'seed server has no credential');
    await db.query(
      `insert into mcp_servers (id, slug, name, url, enabled, auth_type, auth_header_name, auth_secret_enc, timeout_ms, member_tool_policy, managed_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'seed')`,
      [
        newId(),
        s.slug,
        s.name,
        s.url,
        s.enabled ?? true,
        s.authType,
        s.authType === 'header' ? (s.authHeaderName ?? 'X-Api-Key') : null,
        s.authType !== 'none' && secret ? encryptSecret(secret, config.encryptionKey) : null,
        s.timeoutMs ?? config.defaultToolTimeoutMs,
        JSON.stringify(s.memberToolPolicy ?? { mode: 'all' }),
      ],
    );
    log.info({ slug: s.slug }, 'seeded server');
  }
}
