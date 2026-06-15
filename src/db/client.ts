/**
 * Postgres access layer.
 *
 * A thin wrapper over a `pg` connection pool. Everything in ARES that touches
 * the database depends on the {@link Db} interface, never on `pg` directly, so
 * tests can substitute an in-memory fake and the rest of the system is unaware.
 *
 * Connection target is a single DATABASE_URL (Supabase exposes one). pgvector
 * values are passed/received as the textual `[1,2,3]` form, which `pg` hands us
 * as a string for the `vector` type — see {@link toVectorLiteral}.
 */

import pg from 'pg';

export interface QueryResult<R> {
  rows: R[];
  rowCount: number;
}

/** Minimal query surface. Implemented by {@link PgDb} and faked in tests. */
export interface Db {
  query<R = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<R>>;
  close(): Promise<void>;
}

/**
 * Whether to open the pool over TLS. Off for loopback hosts and for any URL that
 * asks for `sslmode=disable` (plain-text local or container-network Postgres);
 * on otherwise (managed providers like Supabase require it).
 */
function useSsl(connectionString: string): boolean {
  if (/sslmode=disable/i.test(connectionString)) return false;
  try {
    const { hostname } = new URL(connectionString);
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return false;
  } catch {
    if (connectionString.includes('localhost')) return false;
  }
  return true;
}

export class PgDb implements Db {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
      // Supabase requires TLS; `pg` enables it from the URL's sslmode, but we
      // also relax cert verification for the pooled connection string Supabase
      // hands out (a documented Supabase quirk, not a security downgrade for a
      // single-user system connecting to its own DB).
      //
      // Disable TLS for plain-text local/self-hosted Postgres — a loopback host
      // or an explicit `sslmode=disable` (e.g. a Postgres container on the same
      // Docker network, reached as `db`, which doesn't terminate TLS).
      ssl: useSsl(connectionString) ? { rejectUnauthorized: false } : false,
      max: 8,
    });
  }

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<R>> {
    const res = await this.pool.query(sql, params);
    return { rows: res.rows as R[], rowCount: res.rowCount ?? 0 };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Format a numeric vector as the pgvector text literal `[1,2,3]`.
 * pgvector accepts this for `vector` columns and parameters.
 */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

/** Parse a pgvector text value (`[1,2,3]`) back into numbers. */
export function fromVectorLiteral(value: string): number[] {
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .filter((s) => s.length > 0)
    .map(Number);
}
