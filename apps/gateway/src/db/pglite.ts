import { PGlite } from '@electric-sql/pglite';
import type { Db } from './db.ts';

/**
 * Test / local-dev database: real Postgres compiled to WASM, in-process.
 * Excluded from the production build (it imports a devDependency).
 */
export class PgliteDb implements Db {
  private readonly pg: PGlite;

  constructor(pglite?: PGlite) {
    this.pg = pglite ?? new PGlite();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    if (!params || params.length === 0) {
      // No parameters: use the simple protocol so multi-statement scripts (migrations) work.
      const results = await this.pg.exec(sql);
      const last = results[results.length - 1];
      return { rows: (last?.rows ?? []) as T[] };
    }
    const res = await this.pg.query<T>(sql, params as unknown[]);
    return { rows: res.rows };
  }

  async close(): Promise<void> {
    await this.pg.close();
  }
}
