import { createHash } from "node:crypto";
import type { Db } from "./db";
import type { LedgerProof } from "./types";

/**
 * Tamper-evident, append-only ledger.
 *
 * Every row in `transactions` and `audit` is chained: it stores the hash of
 * the previous ledger entry (`prev_hash`), a hash of its own immutable
 * content (`hash`), and a global `seq` so the interleaved order of the two
 * tables is unambiguous. Rewriting or deleting any row breaks the chain and
 * is caught by `verifyLedger`.
 */

export const GENESIS_HASH = "aegis-genesis-" + "0".repeat(32);

export function chainHash(prevHash: string, content: string): string {
  return createHash("sha256").update(prevHash).update(content).digest("hex");
}

/** Canonical content of a transaction's immutable fields. */
export function txContent(parts: {
  walletId: string;
  from: string;
  to: string;
  amount: number;
  purpose: string;
  nonce: string;
  requestedAt: number;
}): string {
  return JSON.stringify([
    parts.walletId,
    parts.from,
    parts.to,
    parts.amount,
    parts.purpose,
    parts.nonce,
    parts.requestedAt,
  ]);
}

/** Canonical content of an audit entry. */
export function auditContent(parts: {
  walletId: string;
  actor: string;
  action: string;
  details: string;
  timestamp: number;
}): string {
  return JSON.stringify([
    parts.walletId,
    parts.actor,
    parts.action,
    parts.details,
    parts.timestamp,
  ]);
}

async function headOf(client: Db): Promise<{ headHash: string; rowCount: number }> {
  const { rows } = await client.execute(
    "SELECT head_hash, row_count FROM ledger_state WHERE id = 1",
  );
  if (rows.length > 0) {
    return {
      headHash: rows[0].head_hash as string,
      rowCount: Number(rows[0].row_count),
    };
  }
  await client.execute(
    "INSERT INTO ledger_state (id, head_hash, row_count) VALUES (1, ?, 0)",
    [GENESIS_HASH],
  );
  return { headHash: GENESIS_HASH, rowCount: 0 };
}

export async function appendLedgerRow(
  client: Db,
  table: "transactions" | "audit",
  columns: string[],
  values: unknown[],
  content: string,
): Promise<{ seq: number; hash: string; prevHash: string }> {
  const head = await headOf(client);
  const seq = head.rowCount + 1;
  const hash = chainHash(head.headHash, content);
  const cols = [...columns, "seq", "prev_hash", "hash", "canonical"];
  const vals = [...values, seq, head.headHash, hash, content];
  await client.execute(
    `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${vals
      .map(() => "?")
      .join(", ")})`,
    vals,
  );
  await client.execute(
    "UPDATE ledger_state SET head_hash = ?, row_count = ? WHERE id = 1",
    [hash, seq],
  );
  return { seq, hash, prevHash: head.headHash };
}

interface LedgerEntry {
  seq: number;
  table: string;
  id: unknown;
  prevHash: string;
  hash: string;
  canonical: string;
  recomputed: string;
}

export async function verifyLedger(client: Db): Promise<LedgerProof> {
  const txRows = await client.execute(
    'SELECT id, seq, prev_hash, hash, canonical, wallet_id, "from", "to", amount, purpose, nonce, requested_at FROM transactions',
  );
  const auditRows = await client.execute(
    "SELECT id, seq, prev_hash, hash, canonical, wallet_id, actor, action, details, timestamp FROM audit",
  );
  const entries: LedgerEntry[] = [
    ...txRows.rows.map((r) => ({
      seq: Number(r.seq),
      table: "transactions",
      id: r.id,
      prevHash: r.prev_hash as string,
      hash: r.hash as string,
      canonical: r.canonical as string,
      recomputed: txContent({
        walletId: r.wallet_id as string,
        from: r.from as string,
        to: r.to as string,
        amount: Number(r.amount),
        purpose: r.purpose as string,
        nonce: r.nonce as string,
        requestedAt: Number(r.requested_at),
      }),
    })),
    ...auditRows.rows.map((r) => ({
      seq: Number(r.seq),
      table: "audit",
      id: r.id,
      prevHash: r.prev_hash as string,
      hash: r.hash as string,
      canonical: r.canonical as string,
      recomputed: auditContent({
        walletId: r.wallet_id as string,
        actor: r.actor as string,
        action: r.action as string,
        details: r.details as string,
        timestamp: Number(r.timestamp),
      }),
    })),
  ].sort((a, b) => a.seq - b.seq);

  let expected = GENESIS_HASH;
  let intact = true;
  let brokenAt: LedgerProof["brokenAt"];

  for (const entry of entries) {
    const contentValid = entry.canonical === entry.recomputed;
    const hashValid = entry.hash === chainHash(entry.prevHash, entry.canonical);
    const linkValid = entry.prevHash === expected;
    if (!contentValid || !hashValid || !linkValid) {
      intact = false;
      brokenAt = {
        seq: entry.seq,
        table: entry.table,
        id: String(entry.id),
      };
      break;
    }
    expected = entry.hash;
  }

  const { headHash } = await headOf(client);
  if (intact && headHash !== expected) {
    intact = false;
  }

  return {
    intact,
    rows: entries.length,
    checked: entries.length,
    brokenAt,
    headHash,
  };
}

/**
 * Rebuilds the chain from the rows' immutable columns. Used by the schema
 * migration (pre-v2 databases have no chain columns yet) and by reset.
 * Ordering falls back to `requested_at` for old rows; `seq` breaks ties.
 */
export async function rechain(
  client: Db,
  tables: Array<"transactions" | "audit">,
): Promise<void> {
  await client.execute(
    "UPDATE ledger_state SET head_hash = ?, row_count = 0 WHERE id = 1",
    [GENESIS_HASH],
  );
  const rows: Array<{
    table: string;
    requestedAt: number;
    content: string;
    id: string;
  }> = [];

  if (tables.includes("transactions")) {
    const tx = await client.execute(
      "SELECT id, wallet_id, \"from\", \"to\", amount, purpose, nonce, requested_at, COALESCE(seq, 0) AS seq FROM transactions",
    );
    for (const r of tx.rows) {
      rows.push({
        table: "transactions",
        requestedAt: Number(r.requested_at),
        id: r.id as string,
        content: txContent({
          walletId: r.wallet_id as string,
          from: r.from as string,
          to: r.to as string,
          amount: Number(r.amount),
          purpose: r.purpose as string,
          nonce: r.nonce as string,
          requestedAt: Number(r.requested_at),
        }),
      });
    }
  }
  if (tables.includes("audit")) {
    const au = await client.execute(
      "SELECT id, wallet_id, actor, action, details, timestamp, COALESCE(seq, 0) AS seq FROM audit",
    );
    for (const r of au.rows) {
      rows.push({
        table: "audit",
        requestedAt: Number(r.timestamp),
        id: r.id as string,
        content: auditContent({
          walletId: r.wallet_id as string,
          actor: r.actor as string,
          action: r.action as string,
          details: r.details as string,
          timestamp: Number(r.timestamp),
        }),
      });
    }
  }

  rows.sort((a, b) => a.requestedAt - b.requestedAt);

  let head = GENESIS_HASH;
  let seq = 0;
  for (const row of rows) {
    seq += 1;
    const hash = chainHash(head, row.content);
    await client.execute(
      `UPDATE ${row.table} SET seq = ?, prev_hash = ?, hash = ?, canonical = ? WHERE id = ?`,
      [seq, head, hash, row.content, row.id],
    );
    head = hash;
  }
  await client.execute(
    "UPDATE ledger_state SET head_hash = ?, row_count = ? WHERE id = 1",
    [head, seq],
  );
}
