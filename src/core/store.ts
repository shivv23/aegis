import { createClient } from "@libsql/client";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AuditLogEntry,
  RejectionReason,
  TxStatus,
  Transaction,
  Wallet,
  WalletPolicy,
  WalletStatus,
} from "./types";
import { assertTransition } from "./stateMachine";
import { seed } from "./seed";

export const HOLD_MS = Number(process.env.AEGIS_HOLD_MS ?? 5000);

function resolveUrl(): string {
  if (process.env.AEGIS_DB_URL) return process.env.AEGIS_DB_URL;
  const dir = join(process.cwd(), "data");
  mkdirSync(dir, { recursive: true });
  return `file:${join(dir, "aegis.db")}`;
}

type StoreShape = {
  client: ReturnType<typeof createClient>;
  events: EventEmitter;
  ready: Promise<void>;
  nonces: Set<string>;
};

const g = globalThis as unknown as { __aegisStore?: StoreShape };

function getStore(): StoreShape {
  if (g.__aegisStore) return g.__aegisStore;

  const client = createClient({ url: resolveUrl() });
  const events = new EventEmitter();
  const ready = init(client);
  const store: StoreShape = { client, events, ready, nonces: new Set() };
  g.__aegisStore = store;
  return store;
}

/**
 * Nonce replay protection. Returns true only the first time a nonce is seen.
 */
export async function consumeNonce(nonce: string): Promise<boolean> {
  const s = getStore();
  await s.ready;
  if (s.nonces.has(nonce)) return false;
  s.nonces.add(nonce);
  return true;
}

async function init(client: ReturnType<typeof createClient>): Promise<void> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS wallets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_did TEXT NOT NULL,
      status TEXT NOT NULL,
      balance REAL NOT NULL,
      max_per_tx REAL NOT NULL,
      daily_limit REAL NOT NULL,
      monthly_limit REAL NOT NULL,
      velocity_limit_per_min INTEGER NOT NULL,
      allowlist TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      wallet_id TEXT NOT NULL,
      "from" TEXT NOT NULL,
      "to" TEXT NOT NULL,
      amount REAL NOT NULL,
      purpose TEXT NOT NULL,
      status TEXT NOT NULL,
      rejection_reason TEXT,
      requested_at INTEGER NOT NULL,
      pending_until INTEGER,
      settled_at INTEGER,
      blocked_at INTEGER,
      revoked_at INTEGER,
      nonce TEXT NOT NULL
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS audit (
      id TEXT PRIMARY KEY,
      wallet_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    )
  `);
  const { rows } = await client.execute("SELECT COUNT(*) AS n FROM wallets");
  if (Number(rows[0]?.n ?? 0) === 0) {
    await seed(client);
  }
}

function rowToWallet(row: Record<string, unknown>): Wallet {
  return {
    id: row.id as string,
    name: row.name as string,
    ownerDid: row.owner_did as string,
    status: row.status as WalletStatus,
    balance: Number(row.balance),
    policy: {
      maxPerTx: Number(row.max_per_tx),
      dailyLimit: Number(row.daily_limit),
      monthlyLimit: Number(row.monthly_limit),
      velocityLimitPerMin: Number(row.velocity_limit_per_min),
      allowlist: JSON.parse(row.allowlist as string) as string[],
    },
    createdAt: Number(row.created_at),
  };
}

function rowToTransaction(row: Record<string, unknown>): Transaction {
  return {
    id: row.id as string,
    walletId: row.wallet_id as string,
    from: row.from as string,
    to: row.to as string,
    amount: Number(row.amount),
    purpose: row.purpose as string,
    status: row.status as TxStatus,
    rejectionReason: (row.rejection_reason as RejectionReason) ?? undefined,
    requestedAt: Number(row.requested_at),
    pendingUntil: row.pending_until
      ? Number(row.pending_until)
      : undefined,
    settledAt: row.settled_at ? Number(row.settled_at) : undefined,
    blockedAt: row.blocked_at ? Number(row.blocked_at) : undefined,
    revokedAt: row.revoked_at ? Number(row.revoked_at) : undefined,
    nonce: row.nonce as string,
  };
}

function rowToAudit(row: Record<string, unknown>): AuditLogEntry {
  return {
    id: row.id as string,
    walletId: row.wallet_id as string,
    actor: row.actor as AuditLogEntry["actor"],
    action: row.action as string,
    details: row.details as string,
    timestamp: Number(row.timestamp),
  };
}

export async function listWallets(): Promise<Wallet[]> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute("SELECT * FROM wallets ORDER BY created_at ASC");
  return rows.map((r) => rowToWallet(r as Record<string, unknown>));
}

export async function getWallet(id: string): Promise<Wallet | null> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute(
    "SELECT * FROM wallets WHERE id = ?",
    [id],
  );
  const row = rows[0];
  return row ? rowToWallet(row as Record<string, unknown>) : null;
}

export async function createWallet(input: {
  id: string;
  name: string;
  ownerDid: string;
  balance: number;
  policy: WalletPolicy;
}): Promise<Wallet> {
  const s = getStore();
  await s.ready;
  await s.client.execute(
    `INSERT INTO wallets (id, name, owner_did, status, balance, max_per_tx, daily_limit, monthly_limit, velocity_limit_per_min, allowlist, created_at)
     VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.name,
      input.ownerDid,
      input.balance,
      input.policy.maxPerTx,
      input.policy.dailyLimit,
      input.policy.monthlyLimit,
      input.policy.velocityLimitPerMin,
      JSON.stringify(input.policy.allowlist),
      Date.now(),
    ],
  );
  const wallet = await getWallet(input.id);
  if (!wallet) throw new Error("Failed to create wallet");
  s.events.emit("wallet", wallet);
  return wallet;
}

export async function updatePolicy(
  id: string,
  policy: Partial<WalletPolicy>,
): Promise<Wallet | null> {
  const s = getStore();
  await s.ready;
  const wallet = await getWallet(id);
  if (!wallet) return null;
  const next: WalletPolicy = { ...wallet.policy, ...policy };
  await s.client.execute(
    `UPDATE wallets SET max_per_tx = ?, daily_limit = ?, monthly_limit = ?, velocity_limit_per_min = ?, allowlist = ? WHERE id = ?`,
    [
      next.maxPerTx,
      next.dailyLimit,
      next.monthlyLimit,
      next.velocityLimitPerMin,
      JSON.stringify(next.allowlist),
      id,
    ],
  );
  const updated = await getWallet(id);
  if (updated) s.events.emit("wallet", updated);
  return updated;
}

export async function setWalletStatus(
  id: string,
  status: WalletStatus,
): Promise<Wallet | null> {
  const s = getStore();
  await s.ready;
  await s.client.execute("UPDATE wallets SET status = ? WHERE id = ?", [
    status,
    id,
  ]);
  const wallet = await getWallet(id);
  if (wallet) {
    if (status === "FROZEN") {
      const pending = await listTransactions(id);
      for (const tx of pending) {
        if (tx.status === "PENDING") {
          await transitionTransaction(tx.id, "REVOKED", {
            rejectionReason: "IN_FLIGHT_REVOKED",
            revokedAt: Date.now(),
          });
          await addAudit({
            walletId: id,
            actor: "system",
            action: "TX_REVOKED_IN_FLIGHT",
            details: `Transaction ${tx.id.slice(0, 8)} revoked because wallet was frozen`,
          });
        }
      }
    }
    s.events.emit("wallet", wallet);
  }
  return wallet;
}

/**
 * Finalizes PENDING transactions whose holding window has elapsed.
 * Settles if the wallet is still ACTIVE, otherwise revokes in-flight.
 */
export async function settleDue(now = Date.now()): Promise<Transaction[]> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute(
    "SELECT * FROM transactions WHERE status = 'PENDING' AND pending_until IS NOT NULL AND pending_until <= ?",
    [now],
  );
  const settled: Transaction[] = [];
  for (const row of rows) {
    const tx = rowToTransaction(row as Record<string, unknown>);
    const wallet = await getWallet(tx.walletId);
    if (!wallet || wallet.status === "FROZEN") {
      await transitionTransaction(tx.id, "REVOKED", {
        rejectionReason: "IN_FLIGHT_REVOKED",
        revokedAt: now,
      });
      await addAudit({
        walletId: tx.walletId,
        actor: "system",
        action: "TX_REVOKED_IN_FLIGHT",
        details: `Transaction ${tx.id.slice(0, 8)} revoked after hold window because wallet was not active`,
      });
    } else {
      await debitWallet(tx.walletId, tx.amount);
      const next = await transitionTransaction(tx.id, "SETTLED", {
        settledAt: now,
      });
      if (next) {
        settled.push(next);
        await addAudit({
          walletId: tx.walletId,
          actor: "system",
          action: "TX_SETTLED",
          details: `${tx.amount} settled to ${tx.to}`,
        });
      }
    }
  }
  return settled;
}

export async function addAudit(entry: Omit<AuditLogEntry, "id" | "timestamp">) {
  const s = getStore();
  await s.ready;
  const id = randomUUID();
  await s.client.execute(
    "INSERT INTO audit (id, wallet_id, actor, action, details, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
    [id, entry.walletId, entry.actor, entry.action, entry.details, Date.now()],
  );
  s.events.emit("audit", {
    id,
    walletId: entry.walletId,
    actor: entry.actor,
    action: entry.action,
    details: entry.details,
    timestamp: Date.now(),
  } satisfies AuditLogEntry);
  return id;
}

export async function createTransaction(
  input: Omit<Transaction, "id">,
): Promise<Transaction> {
  const s = getStore();
  await s.ready;
  const id = randomUUID();
  await s.client.execute(
    `INSERT INTO transactions (id, wallet_id, "from", "to", amount, purpose, status, rejection_reason, requested_at, pending_until, settled_at, blocked_at, revoked_at, nonce)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.walletId,
      input.from,
      input.to,
      input.amount,
      input.purpose,
      input.status,
      input.rejectionReason ?? null,
      input.requestedAt,
      input.pendingUntil ?? null,
      input.settledAt ?? null,
      input.blockedAt ?? null,
      input.revokedAt ?? null,
      input.nonce,
    ],
  );
  const tx = { ...input, id };
  s.events.emit("tx", tx);
  return tx;
}

export async function transitionTransaction(
  id: string,
  to: TxStatus,
  fields: { rejectionReason?: RejectionReason; settledAt?: number; blockedAt?: number; revokedAt?: number } = {},
): Promise<Transaction | null> {
  const s = getStore();
  await s.ready;
  const tx = await getTransaction(id);
  if (!tx) return null;
  const from = tx.status;

  assertTransition(from, to);

  const next: Transaction = {
    ...tx,
    status: to,
    rejectionReason: fields.rejectionReason ?? tx.rejectionReason,
    settledAt: fields.settledAt ?? tx.settledAt,
    blockedAt: fields.blockedAt ?? tx.blockedAt,
    revokedAt: fields.revokedAt ?? tx.revokedAt,
  };

  await s.client.execute(
    `UPDATE transactions SET status = ?, rejection_reason = ?, settled_at = ?, blocked_at = ?, revoked_at = ? WHERE id = ?`,
    [
      next.status,
      next.rejectionReason ?? null,
      next.settledAt ?? null,
      next.blockedAt ?? null,
      next.revokedAt ?? null,
      id,
    ],
  );
  s.events.emit("tx", next);
  return next;
}

export async function getTransaction(id: string): Promise<Transaction | null> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute(
    "SELECT * FROM transactions WHERE id = ?",
    [id],
  );
  const row = rows[0];
  return row ? rowToTransaction(row as Record<string, unknown>) : null;
}

export async function listTransactions(walletId?: string): Promise<Transaction[]> {
  const s = getStore();
  await s.ready;
  const { rows } = walletId
    ? await s.client.execute(
        "SELECT * FROM transactions WHERE wallet_id = ? ORDER BY requested_at DESC",
        [walletId],
      )
    : await s.client.execute(
        "SELECT * FROM transactions ORDER BY requested_at DESC",
      );
  return rows.map((r) => rowToTransaction(r as Record<string, unknown>));
}

export async function debitWallet(id: string, amount: number): Promise<Wallet | null> {
  const s = getStore();
  await s.ready;
  await s.client.execute(
    "UPDATE wallets SET balance = balance - ? WHERE id = ?",
    [amount, id],
  );
  return getWallet(id);
}

export async function listAudit(walletId?: string): Promise<AuditLogEntry[]> {
  const s = getStore();
  await s.ready;
  const { rows } = walletId
    ? await s.client.execute(
        "SELECT * FROM audit WHERE wallet_id = ? ORDER BY timestamp DESC",
        [walletId],
      )
    : await s.client.execute("SELECT * FROM audit ORDER BY timestamp DESC");
  return rows.map((r) => rowToAudit(r as Record<string, unknown>));
}

export { getStore };
export function getEvents() {
  return getStore().events;
}
