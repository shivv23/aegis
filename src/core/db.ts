import {
  createClient,
  type Client as LibSqlClient,
  type InValue,
} from "@libsql/client";
import { Pool, type PoolClient } from "pg";

/**
 * Minimal database abstraction so the ledger can run on libSQL (SQLite)
 * locally and PostgreSQL in production with only an env-var change.
 *
 *   AEGIS_DB_URL=file:./data/aegis.db                 → libSQL (default)
 *   AEGIS_DB_URL=postgres://user:pass@host/db          → PostgreSQL
 *
 * The store only ever calls `execute(sql, params)` with `?` placeholders;
 * the adapter translates them to `$n` for Postgres.
 *
 * `withTransaction` runs a callback inside a single transaction. On the
 * serverless money path this is what makes read-modify-write sequences
 * (ledger head advance, seed, migration, settlement) atomic across the
 * multiple Postgres-backed serverless instances the app can scale to.
 */
export type DbDialect = "libsql" | "postgres";

export interface DbResult {
  rows: Record<string, unknown>[];
  /** Rows affected by the statement (UPDATE/DELETE/INSERT). */
  affected?: number;
}

export interface Db {
  readonly dialect: DbDialect;
  execute(sql: string, params?: unknown[]): Promise<DbResult>;
  withTransaction<T>(
    fn: (tx: Db) => Promise<T>,
    opts?: { isolation?: "committed" | "repeatable-read" },
  ): Promise<T>;
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

/**
 * Wraps an executor so a transaction-bound statement function also satisfies
 * the `Db` shape. Nested `withTransaction` calls on the wrapper simply run on
 * the same (already open) transaction — they never open a second connection,
 * so pool-max-1 backends cannot deadlock.
 */
function bind(db: Db, execute: Db["execute"]): Db {
  return {
    dialect: db.dialect,
    execute,
    withTransaction: <T>(fn: (tx: Db) => Promise<T>) => fn(bind(db, execute)),
    close: () => Promise.resolve(),
  };
}

class LibSqlDb implements Db {
  readonly dialect: DbDialect = "libsql";
  private client: LibSqlClient;
  // libSQL's own `transaction()` is not used: for in-memory databases
  // (`file::memory:`) it opens a brand-new connection that starts empty, and
  // for file databases two concurrent write transactions can trip SQLITE_BUSY.
  // Instead the sqlite3 backend (which is a single connection under the hood)
  // is driven with explicit BEGIN/COMMIT, and every statement is serialized
  // through one promise chain so concurrent readers/writers cannot interleave.
  private chain: Promise<unknown> = Promise.resolve();
  private inTx = false;

  constructor(url: string) {
    this.client = createClient({ url });
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => {});
    return run;
  }

  private async rawExecute(sql: string, params: unknown[] = []) {
    const res = await this.client.execute(sql, params as InValue[]);
    return {
      rows: res.rows as Record<string, unknown>[],
      affected: res.rowsAffected,
    };
  }

  execute(sql: string, params: unknown[] = []) {
    // Statements issued from inside a managed transaction already hold the
    // chain lock, so they must run inline instead of re-queuing (deadlock).
    if (this.inTx) return this.rawExecute(sql, params);
    return this.runExclusive(() => this.rawExecute(sql, params));
  }

  withTransaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    // Nested withTransaction calls (e.g. appendLedgerRow inside runSeed) run
    // on the already-open transaction and never take the chain lock.
    if (this.inTx) {
      const bound = bind(this, (sql, params = []) =>
        this.rawExecute(sql, params),
      );
      return fn(bound);
    }
    return this.runExclusive(async () => {
      await this.client.execute("BEGIN");
      this.inTx = true;
      const bound = bind(this, (sql, params = []) =>
        this.rawExecute(sql, params),
      );
      try {
        const result = await fn(bound);
        await this.client.execute("COMMIT");
        return result;
      } catch (e) {
        await this.client.execute("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        this.inTx = false;
      }
    });
  }

  async close() {
    this.client.close();
  }
}

class PgDb implements Db {
  readonly dialect: DbDialect = "postgres";
  private pool: Pool;

  constructor(url: string) {
    this.pool = new Pool({ connectionString: url, max: 1 });
  }

  async execute(sql: string, params: unknown[] = []) {
    const { sql: translated, params: translatedParams } =
      translatePlaceholders(sql, params);
    const result = await this.pool.query(translated, translatedParams);
    return {
      rows: result.rows as Record<string, unknown>[],
      affected: result.rowCount ?? undefined,
    };
  }

  async withTransaction<T>(
    fn: (tx: Db) => Promise<T>,
    opts?: { isolation?: "committed" | "repeatable-read" },
  ): Promise<T> {
    const conn: PoolClient = await this.pool.connect();
    const execute: Db["execute"] = async (sql: string, params: unknown[] = []) => {
      const { sql: translated, params: translatedParams } =
        translatePlaceholders(sql, params);
      const result = await conn.query(translated, translatedParams);
      return {
        rows: result.rows as Record<string, unknown>[],
        affected: result.rowCount ?? undefined,
      };
    };
    const bound = bind(this, execute);
    try {
      await conn.query("BEGIN");
      if (opts?.isolation === "repeatable-read") {
        await conn.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      }
      const result = await fn(bound);
      await conn.query("COMMIT");
      return result;
    } catch (e) {
      await conn.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      conn.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

export function createDb(url: string): Db {
  return isPostgresUrl(url) ? new PgDb(url) : new LibSqlDb(url);
}

export function dbType(): DbDialect {
  const url = process.env.AEGIS_DB_URL ?? "file:./data/aegis.db";
  return isPostgresUrl(url) ? "postgres" : "libsql";
}
