/**
 * Minimal database abstraction so that `pg` (production) and PGlite (tests / dev:pglite) are
 * interchangeable. Plain SQL with positional parameters, no ORM.
 */
export interface Db {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}

/** Postgres `int8`/`bigserial` arrive as strings from `pg` and as numbers from PGlite. */
export function asNumber(v: unknown): number {
  return typeof v === 'number' ? v : Number(v);
}

/** `timestamptz` arrives as a Date from both drivers; tolerate strings for safety. */
export function toIso(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
