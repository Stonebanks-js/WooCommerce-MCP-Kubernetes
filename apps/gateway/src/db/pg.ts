import pg from 'pg';
import type { Db } from './db.ts';

/** Production database: a `pg.Pool` behind the tiny `Db` interface. */
export class PgDb implements Db {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    const res = await this.pool.query(sql, params as unknown[] | undefined);
    return { rows: res.rows as T[] };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
