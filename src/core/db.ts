import {
  createClient,
  type Client as LibSqlClient,
  type InValue,
} from "@libsql/client";
import { Pool } from "pg";

/**
 * Minimal database abstraction so the ledger can run on libSQL (SQLite)
 * locally and PostgreSQL in production with only an env-var change.
 *
 *   AEGIS_DB_URL=file:./data/aegis.db                 → libSQL (default)
 *   AEGIS_DB_URL=postgres://user:pass@host/db          → PostgreSQL
 *
 * The store only ever calls `execute(sql, params)` with `?` placeholders;
 * the adapter translates them to `$n` for Postgres.
 */
export interface Db {
  execute(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  close(): Promise<void>;
}

function isPostgresUrl(url: string): boolean {
  return url.startsWith("postgres://") || url.startsWith("postgresql://");
}

function translatePlaceholders(
  sql: string,
  params: unknown[],
): { sql: string; params: unknown[] } {
  let i = 0;
  const converted = sql.replace(/\?/g, () => `$${++i}`);
  return { sql: converted, params };
}

class LibSqlDb implements Db {
  private client: LibSqlClient;

  constructor(url: string) {
    this.client = createClient({ url });
  }

  async execute(sql: string, params: unknown[] = []) {
    const { rows } = await this.client.execute(
      sql,
      params as InValue[],
    );
    return { rows: rows as Record<string, unknown>[] };
  }

  async close() {
    this.client.close();
  }
}

class PgDb implements Db {
  private pool: Pool;

  constructor(url: string) {
    this.pool = new Pool({ connectionString: url, max: 1 });
  }

  async execute(sql: string, params: unknown[] = []) {
    const { sql: translated, params: translatedParams } =
      translatePlaceholders(sql, params);
    const result = await this.pool.query(translated, translatedParams);
    return { rows: result.rows as Record<string, unknown>[] };
  }

  async close() {
    await this.pool.end();
  }
}

export function createDb(url: string): Db {
  return isPostgresUrl(url) ? new PgDb(url) : new LibSqlDb(url);
}

export function dbType(): "libsql" | "postgres" {
  const url = process.env.AEGIS_DB_URL ?? "file:./data/aegis.db";
  return isPostgresUrl(url) ? "postgres" : "libsql";
}
