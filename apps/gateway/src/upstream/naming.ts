import { sha256Hex } from '../crypto/random.ts';

export const SLUG_RE = /^[a-z][a-z0-9-]{1,19}$/;
export const MAX_PUBLIC_NAME_LENGTH = 64;

/**
 * Public tool name = `<slug>__<upstreamName>`. When that exceeds 64 chars it is truncated to 55
 * chars + `_` + the first 8 hex chars of sha256(`slug/name`), which stays unique per (slug, name).
 * Routing never re-derives the upstream name from the public one: the registry keeps an exact map.
 */
export function publicToolName(slug: string, upstreamName: string): string {
  const full = `${slug}__${upstreamName}`;
  if (full.length <= MAX_PUBLIC_NAME_LENGTH) return full;
  return `${full.slice(0, 55)}_${sha256Hex(`${slug}/${upstreamName}`).slice(0, 8)}`;
}

/** Public descriptions are prefixed with the server display name so the model knows the source. */
export function describeWithSource(serverName: string, description: string | undefined): string {
  return `[${serverName}] ${description ?? ''}`.trimEnd();
}
