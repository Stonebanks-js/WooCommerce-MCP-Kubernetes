import { readdir, readFile } from 'node:fs/promises';
import type { Db } from './db.ts';
import type { Logger } from '../log.ts';

const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url);

/**
 * Applies `migrations/NNN_name.sql` in lexical order, recording each file in `schema_migrations`.
 * Each file runs inside one transaction.
 */
export async function migrate(db: Db, log?: Logger, dir: URL = MIGRATIONS_DIR): Promise<string[]> {
  await db.query(
    'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())',
  );
  const files = (await readdir(dir)).filter((f) => /^\d{3}_[a-z0-9_-]+\.sql$/i.test(f)).sort();
  const applied = new Set(
    (await db.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name),
  );
  const done: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(new URL(file, dir), 'utf8');
    await db.query(`begin;\n${sql}\ninsert into schema_migrations(name) values ('${file}');\ncommit;`);
    done.push(file);
    log?.info({ migration: file }, 'migration applied');
  }
  return done;
}
