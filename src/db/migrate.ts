/**
 * Migration runner.
 *
 * Applies every `migrations/*.sql` file in lexical order, exactly once, tracked
 * in a `schema_migrations` table. Idempotent: already-applied files are skipped.
 * Each file runs inside a transaction so a partial failure rolls back cleanly.
 *
 * Run it with:  `npm run migrate`
 */

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { PgDb, type Db } from './client.js';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

export async function runMigrations(db: Db, expectedEmbeddingDim: number): Promise<string[]> {
  await db.query(`
    create table if not exists schema_migrations (
      name       text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied = new Set(
    (await db.query<{ name: string }>('select name from schema_migrations')).rows.map(
      (r) => r.name,
    ),
  );

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    await db.query('begin');
    try {
      await db.query(sql);
      await db.query('insert into schema_migrations (name) values ($1)', [file]);
      await db.query('commit');
      ran.push(file);
    } catch (err) {
      await db.query('rollback');
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    }
  }

  // Guard against an embedding-dimension mismatch between .env and the schema.
  const dim = await embeddingDimension(db);
  if (dim !== null && dim !== expectedEmbeddingDim) {
    throw new Error(
      `semantic_memory.embedding is vector(${dim}) but ARES_EMBEDDING_DIM=${expectedEmbeddingDim}. ` +
        `Re-embed and update the migration, or fix the env var.`,
    );
  }

  return ran;
}

/** Read the declared dimension of the embedding column, if the table exists. */
async function embeddingDimension(db: Db): Promise<number | null> {
  const res = await db.query<{ dim: number | null }>(`
    select atttypmod as dim
    from pg_attribute
    where attrelid = 'semantic_memory'::regclass and attname = 'embedding'
  `).catch(() => ({ rows: [] as { dim: number | null }[], rowCount: 0 }));
  const dim = res.rows[0]?.dim;
  return typeof dim === 'number' && dim > 0 ? dim : null;
}

// CLI entry: only run when invoked directly (not when imported).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const config = loadConfig();
  if (!config.databaseUrl) {
    // eslint-disable-next-line no-console
    console.error('DATABASE_URL is not set; nothing to migrate.');
    process.exit(1);
  }
  const db = new PgDb(config.databaseUrl);
  runMigrations(db, config.embeddingDim)
    .then((ran) => {
      // eslint-disable-next-line no-console
      console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'No pending migrations.');
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('migration error:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => db.close());
}
