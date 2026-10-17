import { z } from 'zod';

export const memberToolPolicySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('all') }),
  z.object({ mode: z.literal('allowlist'), patterns: z.array(z.string().min(1).max(100)).max(200) }),
  z.object({ mode: z.literal('denylist'), patterns: z.array(z.string().min(1).max(100)).max(200) }),
]);

export type MemberToolPolicy = z.infer<typeof memberToolPolicySchema>;

const cache = new Map<string, RegExp>();

/** Glob where `*` is the only wildcard; everything else is literal. Whole-string match. */
export function globToRegExp(pattern: string): RegExp {
  const hit = cache.get(pattern);
  if (hit) return hit;
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  const re = new RegExp(`^${source}$`);
  if (cache.size < 1000) cache.set(pattern, re);
  return re;
}

export const matchesAny = (patterns: string[], name: string): boolean =>
  patterns.some((p) => globToRegExp(p).test(name));

/** Admins never go through this; it decides what members may see and call. */
export function isToolAllowed(policy: MemberToolPolicy, upstreamToolName: string): boolean {
  switch (policy.mode) {
    case 'all':
      return true;
    case 'allowlist':
      return matchesAny(policy.patterns, upstreamToolName);
    case 'denylist':
      return !matchesAny(policy.patterns, upstreamToolName);
  }
}

/** Defensive parse of a stored jsonb value; anything unexpected degrades to `{mode:'all'}`. */
export function parsePolicy(value: unknown): MemberToolPolicy {
  const r = memberToolPolicySchema.safeParse(value);
  return r.success ? r.data : { mode: 'all' };
}
