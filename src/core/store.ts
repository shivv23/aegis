import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createDb, type Db } from "./db";
import type {
  Approval,
  AuditLogEntry,
  AgentKeyRecord,
  OutboxEntry,
  PolicyVersion,
  PolicyVersionStatus,
  RejectionReason,
  Signer,
  SignerRole,
  TxStatus,
  Transaction,
  Wallet,
  WalletPolicy,
  WalletStatus,
} from "./types";
import { assertTransition } from "./stateMachine";
import { appendLedgerRow, GENESIS_HASH, rechain, txContent, auditContent, verifyLedger as verifyChain } from "./ledger";
import { getRail } from "./rails";
import { signKey } from "./keys";
import { SEED_VENDORS, SEED_WALLET_ID } from "./seed";

export const HOLD_MS = Number(process.env.AEGIS_HOLD_MS ?? 5000);

/** How long an owner has to approve/reject a high-risk transfer. */
export const STEP_UP_TTL_MS = Number(process.env.AEGIS_STEPUP_TTL_MS ?? 120000);

/** Circuit breaker: N guard anomalies within the window → auto-freeze. */
export const BREAKER_THRESHOLD = Number(process.env.AEGIS_BREAKER_THRESHOLD ?? 5);
export const BREAKER_WINDOW_MS = Number(process.env.AEGIS_BREAKER_WINDOW_MS ?? 60000);

const isDemoMode = () => process.env.AEGIS_DEMO_MODE !== "0";

/** Policy changes take effect after a timelock. Disabled in demo mode. */
export const POLICY_TIMELOCK_MS = process.env.AEGIS_POLICY_TIMELOCK_MS
  ? Number(process.env.AEGIS_POLICY_TIMELOCK_MS)
  : isDemoMode()
    ? 0
    : 300000;

export function policyHash(policy: WalletPolicy): string {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}

function resolveUrl(): string {
  if (process.env.AEGIS_DB_URL) return process.env.AEGIS_DB_URL;
  const dir = join(process.cwd(), "data");
  mkdirSync(dir, { recursive: true });
  return `file:${join(dir, "aegis.db")}`;
}

type StoreShape = {
  client: Db;
  events: EventEmitter;
  ready: Promise<void>;
  nonces: Set<string>;
  anomalies: Map<string, number[]>;
};

const g = globalThis as unknown as { __aegisStore?: StoreShape };

function getStore(): StoreShape {
  if (g.__aegisStore) return g.__aegisStore;

  const client = createDb(resolveUrl());
  const events = new EventEmitter();
  const ready = init(client);
  const store: StoreShape = { client, events, ready, nonces: new Set(), anomalies: new Map() };
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

async function hasColumn(client: Db, table: string, column: string): Promise<boolean> {
  try {
    const { rows } = await client.execute(
      `SELECT ${column} FROM ${table} LIMIT 1`,
    );
    void rows;
    return true;
  } catch {
    return false;
  }
}

async function init(client: Db): Promise<void> {
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
      created_at BIGINT NOT NULL
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
      requested_at BIGINT NOT NULL,
      pending_until BIGINT,
      settled_at BIGINT,
      blocked_at BIGINT,
      revoked_at BIGINT,
      nonce TEXT NOT NULL,
      step_up_score REAL,
      external_ref TEXT,
      seq BIGINT,
      prev_hash TEXT,
      hash TEXT,
      canonical TEXT
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS audit (
      id TEXT PRIMARY KEY,
      wallet_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT NOT NULL,
      timestamp BIGINT NOT NULL,
      seq BIGINT,
      prev_hash TEXT,
      hash TEXT,
      canonical TEXT
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS ledger_state (
      id INTEGER PRIMARY KEY,
      head_hash TEXT NOT NULL,
      row_count BIGINT NOT NULL
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS agent_keys (
      wallet_id TEXT NOT NULL,
      public_key TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      revoked_at BIGINT
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS policy_versions (
      id TEXT PRIMARY KEY,
      wallet_id TEXT NOT NULL,
      policy TEXT NOT NULL,
      policy_hash TEXT NOT NULL,
      created_by TEXT NOT NULL,
      effective_at BIGINT NOT NULL,
      created_at BIGINT NOT NULL,
      status TEXT NOT NULL
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY,
      wallet_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      delivered_at BIGINT,
      attempt_count INTEGER NOT NULL
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS signers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      created_at BIGINT NOT NULL
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      operation TEXT NOT NULL,
      wallet_id TEXT NOT NULL,
      label TEXT NOT NULL,
      proposer TEXT NOT NULL,
      required INTEGER NOT NULL,
      approvers TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL,
      key_minted INTEGER NOT NULL
    )
  `);

  // v1 → v2 migration: old tables lack the hash-chain columns.
  const migrated: Array<"transactions" | "audit"> = [];
  if (!(await hasColumn(client, "transactions", "seq"))) {
    await client.execute("ALTER TABLE transactions ADD COLUMN seq INTEGER");
    await client.execute("ALTER TABLE transactions ADD COLUMN prev_hash TEXT");
    await client.execute("ALTER TABLE transactions ADD COLUMN hash TEXT");
    await client.execute("ALTER TABLE transactions ADD COLUMN canonical TEXT");
    migrated.push("transactions");
  }
  if (!(await hasColumn(client, "transactions", "step_up_score"))) {
    await client.execute("ALTER TABLE transactions ADD COLUMN step_up_score REAL");
  }
  if (!(await hasColumn(client, "transactions", "external_ref"))) {
    await client.execute("ALTER TABLE transactions ADD COLUMN external_ref TEXT");
  }
  if (!(await hasColumn(client, "audit", "seq"))) {
    await client.execute("ALTER TABLE audit ADD COLUMN seq INTEGER");
    await client.execute("ALTER TABLE audit ADD COLUMN prev_hash TEXT");
    await client.execute("ALTER TABLE audit ADD COLUMN hash TEXT");
    await client.execute("ALTER TABLE audit ADD COLUMN canonical TEXT");
    migrated.push("audit");
  }
  if (migrated.length > 0) {
    await rechain(client, migrated);
  }

  const { rows } = await client.execute("SELECT COUNT(*) AS n FROM wallets");
  if (Number(rows[0]?.n ?? 0) === 0) {
    await runSeed(client);
  }
}

/**
 * Seeds the demo wallet through the same chained-insert path the API uses,
 * so the seeded ledger verifies like any other. Runs during init (before
 * `ready` resolves) — must not call functions that await `ready`.
 */
async function runSeed(client: Db): Promise<void> {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  const policy: WalletPolicy = {
    maxPerTx: 100,
    dailyLimit: 1000,
    monthlyLimit: 5000,
    velocityLimitPerMin: 30,
    allowlist: [...SEED_VENDORS],
  };

  await client.execute(
    `INSERT INTO wallets (id, name, owner_did, status, balance, max_per_tx, daily_limit, monthly_limit, velocity_limit_per_min, allowlist, created_at)
     VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?)`,
    [
      SEED_WALLET_ID,
      "TradingBot-42",
      "did:org:acme",
      9975,
      policy.maxPerTx,
      policy.dailyLimit,
      policy.monthlyLimit,
      policy.velocityLimitPerMin,
      JSON.stringify(policy.allowlist),
      now - 30 * dayMs,
    ],
  );

  const history: Array<{
    to: string;
    amount: number;
    purpose: string;
    age: number;
  }> = [
    { to: "compute:0xCAFE0001", amount: 40, purpose: "GPU burst #147", age: 50 },
    { to: "api:0xBEEF0002", amount: 15, purpose: "LLM API quota", age: 30 },
    { to: "storage:0xDEAD0003", amount: 8, purpose: "Vector DB storage", age: 15 },
    { to: "compute:0xCAFE0001", amount: 25, purpose: "GPU burst #146", age: 10 },
  ];

  for (const h of history) {
    const settledAt = now - h.age;
    const nonce = randomUUID();
    const content = txContent({
      walletId: SEED_WALLET_ID,
      from: SEED_WALLET_ID,
      to: h.to,
      amount: h.amount,
      purpose: h.purpose,
      nonce,
      requestedAt: settledAt,
    });
    await appendLedgerRow(
      client,
      "transactions",
      ["id", "wallet_id", "from", "to", "amount", "purpose", "status", "rejection_reason", "requested_at", "pending_until", "settled_at", "blocked_at", "revoked_at", "nonce"],
      [
        randomUUID(),
        SEED_WALLET_ID,
        SEED_WALLET_ID,
        h.to,
        h.amount,
        h.purpose,
        "SETTLED",
        null,
        settledAt,
        settledAt,
        settledAt,
        null,
        null,
        nonce,
      ],
      content,
    );
  }

  await client.execute(
    `INSERT INTO policy_versions (id, wallet_id, policy, policy_hash, created_by, effective_at, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
    [
      randomUUID(),
      SEED_WALLET_ID,
      JSON.stringify(policy),
      policyHash(policy),
      "system",
      now - 30 * dayMs,
      now - 30 * dayMs,
    ],
  );

  await appendLedgerRow(
    client,
    "audit",
    ["id", "wallet_id", "actor", "action", "details", "timestamp"],
    [
      randomUUID(),
      SEED_WALLET_ID,
      "system",
      "WALLET_CREATED",
      "Wallet provisioned for TradingBot-42",
      now - 30 * dayMs,
    ],
    auditContent({
      walletId: SEED_WALLET_ID,
      actor: "system",
      action: "WALLET_CREATED",
      details: "Wallet provisioned for TradingBot-42",
      timestamp: now - 30 * dayMs,
    }),
  );
  await appendLedgerRow(
    client,
    "audit",
    ["id", "wallet_id", "actor", "action", "details", "timestamp"],
    [
      randomUUID(),
      SEED_WALLET_ID,
      "system",
      "POLICY_SET",
      "maxPerTx=$100 dailyLimit=$1000 monthlyLimit=$5000 velocity=30/min",
      now - 30 * dayMs,
    ],
    auditContent({
      walletId: SEED_WALLET_ID,
      actor: "system",
      action: "POLICY_SET",
      details: "maxPerTx=$100 dailyLimit=$1000 monthlyLimit=$5000 velocity=30/min",
      timestamp: now - 30 * dayMs,
    }),
  );
}

export async function resetStore(): Promise<Wallet[]> {
  const s = getStore();
  await s.ready;
  s.nonces.clear();
  s.anomalies.clear();
  await s.client.execute("DELETE FROM transactions");
  await s.client.execute("DELETE FROM audit");
  await s.client.execute("DELETE FROM wallets");
  await s.client.execute("DELETE FROM agent_keys");
  await s.client.execute("DELETE FROM policy_versions");
  await s.client.execute("DELETE FROM outbox");
  await s.client.execute("DELETE FROM signers");
  await s.client.execute("DELETE FROM approvals");
  await s.client.execute(
    "UPDATE ledger_state SET head_hash = ?, row_count = 0 WHERE id = 1",
    [GENESIS_HASH],
  );
  await runSeed(s.client);
  const wallets = await listWallets();
  s.events.emit("reset", wallets);
  return wallets;
}

export function verifyLedger() {
  const s = getStore();
  return s.ready.then(() => verifyChain(s.client));
}

export async function recordOutbox(
  walletId: string,
  eventType: string,
  payload: unknown,
): Promise<OutboxEntry> {
  const s = getStore();
  await s.ready;
  const entry: OutboxEntry = {
    id: randomUUID(),
    walletId,
    eventType,
    payload: typeof payload === "string" ? payload : JSON.stringify(payload),
    createdAt: Date.now(),
    attemptCount: 0,
  };
  await s.client.execute(
    "INSERT INTO outbox (id, wallet_id, event_type, payload, created_at, attempt_count) VALUES (?, ?, ?, ?, ?, 0)",
    [entry.id, walletId, eventType, entry.payload, entry.createdAt],
  );
  s.events.emit("alert", entry);
  return entry;
}

export async function listOutbox(walletId?: string): Promise<OutboxEntry[]> {
  const s = getStore();
  await s.ready;
  const { rows } = walletId
    ? await s.client.execute(
        "SELECT * FROM outbox WHERE wallet_id = ? ORDER BY created_at DESC LIMIT 200",
        [walletId],
      )
    : await s.client.execute(
        "SELECT * FROM outbox ORDER BY created_at DESC LIMIT 200",
      );
  return rows.map((r) => ({
    id: r.id as string,
    walletId: r.wallet_id as string,
    eventType: r.event_type as string,
    payload: r.payload as string,
    createdAt: Number(r.created_at),
    deliveredAt: r.delivered_at ? Number(r.delivered_at) : undefined,
    attemptCount: Number(r.attempt_count),
  }));
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
    stepUpScore: row.step_up_score != null ? Number(row.step_up_score) : undefined,
    externalRef: row.external_ref ? (row.external_ref as string) : undefined,
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
  await createPolicyVersion(input.id, input.policy, "owner");
  s.events.emit("wallet", wallet);
  return wallet;
}

export async function createPolicyVersion(
  walletId: string,
  policy: WalletPolicy,
  createdBy: string,
): Promise<PolicyVersion> {
  const s = getStore();
  await s.ready;
  const now = Date.now();
  const version: PolicyVersion = {
    id: randomUUID(),
    walletId,
    policy,
    policyHash: policyHash(policy),
    createdBy,
    effectiveAt: now + POLICY_TIMELOCK_MS,
    createdAt: now,
    status: "PENDING",
  };
  await s.client.execute(
    "INSERT INTO policy_versions (id, wallet_id, policy, policy_hash, created_by, effective_at, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING')",
    [
      version.id,
      walletId,
      JSON.stringify(policy),
      version.policyHash,
      createdBy,
      version.effectiveAt,
      now,
    ],
  );
  s.events.emit("policy", version);
  return version;
}

export async function getPendingPolicy(
  walletId: string,
): Promise<PolicyVersion | null> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute(
    "SELECT * FROM policy_versions WHERE wallet_id = ? AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1",
    [walletId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id as string,
    walletId: row.wallet_id as string,
    policy: JSON.parse(row.policy as string) as WalletPolicy,
    policyHash: row.policy_hash as string,
    createdBy: row.created_by as string,
    effectiveAt: Number(row.effective_at),
    createdAt: Number(row.created_at),
    status: "PENDING",
  };
}

export async function listPolicyVersions(walletId?: string): Promise<PolicyVersion[]> {
  const s = getStore();
  await s.ready;
  const { rows } = walletId
    ? await s.client.execute(
        "SELECT * FROM policy_versions WHERE wallet_id = ? ORDER BY created_at DESC",
        [walletId],
      )
    : await s.client.execute("SELECT * FROM policy_versions ORDER BY created_at DESC");
  return rows.map((r) => ({
    id: r.id as string,
    walletId: r.wallet_id as string,
    policy: JSON.parse(r.policy as string) as WalletPolicy,
    policyHash: r.policy_hash as string,
    createdBy: r.created_by as string,
    effectiveAt: Number(r.effective_at),
    createdAt: Number(r.created_at),
    status: r.status as PolicyVersionStatus,
  }));
}

/**
 * Applies PENDING policy versions whose timelock has elapsed. Only the
 * newest pending per wallet becomes effective; stale pendings are
 * superseded. Deterministic by construction.
 */
export async function promoteDuePolicies(now = Date.now()): Promise<number> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute(
    "SELECT * FROM policy_versions WHERE status = 'PENDING' AND effective_at <= ? ORDER BY wallet_id ASC, created_at ASC",
    [now],
  );
  // Newest PENDING per wallet wins (last write per wallet_id).
  const newestByWallet = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    newestByWallet.set(row.wallet_id as string, row);
  }

  let promoted = 0;
  for (const [walletId, row] of newestByWallet) {
    const policy = JSON.parse(row.policy as string) as WalletPolicy;
    await s.client.execute(
      "UPDATE wallets SET max_per_tx = ?, daily_limit = ?, monthly_limit = ?, velocity_limit_per_min = ?, allowlist = ? WHERE id = ?",
      [
        policy.maxPerTx,
        policy.dailyLimit,
        policy.monthlyLimit,
        policy.velocityLimitPerMin,
        JSON.stringify(policy.allowlist),
        walletId,
      ],
    );
    await s.client.execute(
      "UPDATE policy_versions SET status = 'ACTIVE' WHERE id = ?",
      [row.id as string],
    );
    await s.client.execute(
      "UPDATE policy_versions SET status = 'SUPERSEDED' WHERE wallet_id = ? AND id != ? AND status = 'PENDING'",
      [walletId, row.id as string],
    );
    promoted += 1;
    await addAudit({
      walletId,
      actor: "system",
      action: "POLICY_ACTIVATED",
      details: `Timelocked policy ${String(row.policy_hash).slice(0, 12)} became effective`,
    });
    const wallet = await getWallet(walletId);
    if (wallet) s.events.emit("wallet", wallet);
  }
  return promoted;
}

/**
 * Records a policy change as a timelocked version. Returns the current
 * (still effective) wallet plus the pending version.
 */
export async function updatePolicy(
  id: string,
  partial: Partial<WalletPolicy>,
  createdBy = "owner",
): Promise<{ wallet: Wallet; pending: PolicyVersion } | null> {
  const wallet = await getWallet(id);
  if (!wallet) return null;
  const next: WalletPolicy = { ...wallet.policy, ...partial };
  const pending = await createPolicyVersion(id, next, createdBy);
  if (POLICY_TIMELOCK_MS === 0) {
    await promoteDuePolicies(Date.now() + 1);
    return { wallet: (await getWallet(id))!, pending };
  }
  return { wallet, pending };
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
    await recordOutbox(
      id,
      status === "FROZEN" ? "WALLET_FROZEN" : "WALLET_UNFROZEN",
      { status },
    );
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
  await promoteDuePolicies(now);
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
      const result = await getRail().execute({
        txId: tx.id,
        walletId: tx.walletId,
        to: tx.to,
        amount: tx.amount,
        purpose: tx.purpose,
        nonce: tx.nonce,
        requestedAt: tx.requestedAt,
      });
      if (result.status === "FAILED") {
        await transitionTransaction(tx.id, "BLOCKED", {
          rejectionReason: "RAIL_FAILED",
          blockedAt: now,
        });
        await addAudit({
          walletId: tx.walletId,
          actor: "system",
          action: "TX_SETTLEMENT_FAILED",
          details: `Rail ${getRail().id} rejected settlement of ${tx.amount} to ${tx.to}: ${result.detail ?? "unknown"}`,
        });
        continue;
      }
      await debitWallet(tx.walletId, tx.amount);
      const next = await transitionTransaction(tx.id, "SETTLED", {
        settledAt: now,
        externalRef: result.externalRef,
      });
      if (next) {
        settled.push(next);
        await addAudit({
          walletId: tx.walletId,
          actor: "system",
          action: "TX_SETTLED",
          details: `${tx.amount} settled to ${tx.to} via rail ${getRail().id} (${result.externalRef ?? "local"})`,
        });
      }
    }
  }
  return settled;
}

/**
 * Converts STEP_UP_REQUIRED transactions whose decision window has elapsed
 * into BLOCKED. Returns the ids that expired.
 */
export async function expireStepUps(now = Date.now()): Promise<string[]> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute(
    "SELECT id, wallet_id FROM transactions WHERE status = 'STEP_UP_REQUIRED' AND pending_until IS NOT NULL AND pending_until <= ?",
    [now],
  );
  const expired: string[] = [];
  for (const row of rows) {
    const id = row.id as string;
    const walletId = row.wallet_id as string;
    await transitionTransaction(id, "BLOCKED", {
      rejectionReason: "STEP_UP_EXPIRED",
      blockedAt: now,
    });
    await addAudit({
      walletId,
      actor: "system",
      action: "STEP_UP_EXPIRED",
      details: `High-risk transfer ${id.slice(0, 8)} expired without owner decision`,
    });
    expired.push(id);
  }
  return expired;
}

/**
 * Owner approves a STEP_UP_REQUIRED transfer → it enters the normal holding
 * window and will settle once it elapses.
 */
export async function approveStepUp(
  id: string,
): Promise<{ tx: Transaction; wallet: Wallet | null } | null> {
  const s = getStore();
  await s.ready;
  const tx = await getTransaction(id);
  if (!tx || tx.status !== "STEP_UP_REQUIRED") return null;
  const now = Date.now();
  const next = await transitionTransaction(id, "PENDING", {
    pendingUntil: now + HOLD_MS,
  });
  await addAudit({
    walletId: tx.walletId,
    actor: "owner",
    action: "STEP_UP_APPROVED",
    details: `Owner approved high-risk transfer of ${tx.amount} to ${tx.to} (risk score ${tx.stepUpScore ?? "?"})`,
  });
  await recordOutbox(tx.walletId, "STEP_UP_APPROVED", {
    txId: id,
    amount: tx.amount,
    to: tx.to,
  });
  return { tx: next!, wallet: await getWallet(tx.walletId) };
}

export async function declineStepUp(
  id: string,
): Promise<Transaction | null> {
  const tx = await getTransaction(id);
  if (!tx || tx.status !== "STEP_UP_REQUIRED") return null;
  const next = await transitionTransaction(id, "BLOCKED", {
    rejectionReason: "STEP_UP_DECLINED",
    blockedAt: Date.now(),
  });
  await addAudit({
    walletId: tx.walletId,
    actor: "owner",
    action: "STEP_UP_DECLINED",
    details: `Owner declined high-risk transfer of ${tx.amount} to ${tx.to}`,
  });
  await recordOutbox(tx.walletId, "STEP_UP_DECLINED", {
    txId: id,
    amount: tx.amount,
    to: tx.to,
  });
  return next;
}

/**
 * Circuit breaker state. Returns the number of anomalies observed in the
 * current window and whether the wallet is already frozen.
 */
export function getBreakerState(
  walletId: string,
): { threshold: number; windowMs: number; anomalies: number; tripped: boolean } {
  const s = getStore();
  const windowMs = BREAKER_WINDOW_MS;
  const cutoff = Date.now() - windowMs;
  const timestamps = (s.anomalies.get(walletId) ?? []).filter((t) => t >= cutoff);
  s.anomalies.set(walletId, timestamps);
  return {
    threshold: BREAKER_THRESHOLD,
    windowMs,
    anomalies: timestamps.length,
    tripped: timestamps.length >= BREAKER_THRESHOLD,
  };
}

/**
 * Records a guard anomaly (blocked transfer, rejected signature, critical
 * risk) for the circuit breaker. If the anomaly count crosses the threshold
 * within the window, the wallet is auto-frozen. Returns what happened.
 */
export async function recordAnomaly(
  walletId: string,
  eventType: string,
  details: string,
): Promise<{ frozen: boolean; count: number }> {
  const s = getStore();
  await s.ready;
  const cutoff = Date.now() - BREAKER_WINDOW_MS;
  const timestamps = (s.anomalies.get(walletId) ?? []).filter((t) => t >= cutoff);
  timestamps.push(Date.now());
  s.anomalies.set(walletId, timestamps);
  await recordOutbox(walletId, eventType, { details, anomalyCount: timestamps.length });
  await addAudit({
    walletId,
    actor: "system",
    action: eventType,
    details,
  });

  let frozen = false;
  if (timestamps.length >= BREAKER_THRESHOLD) {
    const wallet = await getWallet(walletId);
    if (wallet && wallet.status !== "FROZEN") {
      await setWalletStatus(walletId, "FROZEN");
      frozen = true;
      await addAudit({
        walletId,
        actor: "system",
        action: "AUTO_FREEZE",
        details: `Circuit breaker tripped after ${timestamps.length} anomalies in ${BREAKER_WINDOW_MS}ms`,
      });
    }
  }
  return { frozen, count: timestamps.length };
}

export async function addAudit(entry: Omit<AuditLogEntry, "id" | "timestamp">) {
  const s = getStore();
  await s.ready;
  const id = randomUUID();
  const timestamp = Date.now();
  await appendLedgerRow(
    s.client,
    "audit",
    ["id", "wallet_id", "actor", "action", "details", "timestamp"],
    [id, entry.walletId, entry.actor, entry.action, entry.details, timestamp],
    auditContent({
      walletId: entry.walletId,
      actor: entry.actor,
      action: entry.action,
      details: entry.details,
      timestamp,
    }),
  );
  const audit: AuditLogEntry = {
    id,
    walletId: entry.walletId,
    actor: entry.actor,
    action: entry.action,
    details: entry.details,
    timestamp,
  };
  s.events.emit("audit", audit);
  await recordOutbox(entry.walletId, entry.action, {
    details: entry.details,
    auditId: id,
  });
  return id;
}

export async function createTransaction(
  input: Omit<Transaction, "id">,
): Promise<Transaction> {
  const s = getStore();
  await s.ready;
  const id = randomUUID();
  await appendLedgerRow(
    s.client,
    "transactions",
    ["id", "wallet_id", "from", "to", "amount", "purpose", "status", "rejection_reason", "requested_at", "pending_until", "settled_at", "blocked_at", "revoked_at", "nonce", "step_up_score", "external_ref"],
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
      input.stepUpScore ?? null,
      input.externalRef ?? null,
    ],
    txContent({
      walletId: input.walletId,
      from: input.from,
      to: input.to,
      amount: input.amount,
      purpose: input.purpose,
      nonce: input.nonce,
      requestedAt: input.requestedAt,
    }),
  );
  const tx = { ...input, id };
  s.events.emit("tx", tx);
  await recordOutbox(
    input.walletId,
    input.status === "BLOCKED" ? "TX_BLOCKED" : "TX_REQUESTED",
    { txId: id, to: input.to, amount: input.amount, status: input.status },
  );
  return tx;
}

export async function transitionTransaction(
  id: string,
  to: TxStatus,
  fields: { rejectionReason?: RejectionReason; settledAt?: number; blockedAt?: number; revokedAt?: number; pendingUntil?: number; externalRef?: string } = {},
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
    pendingUntil: fields.pendingUntil ?? tx.pendingUntil,
    externalRef: fields.externalRef ?? tx.externalRef,
  };

  await s.client.execute(
    `UPDATE transactions SET status = ?, rejection_reason = ?, settled_at = ?, blocked_at = ?, revoked_at = ?, pending_until = ?, external_ref = ? WHERE id = ?`,
    [
      next.status,
      next.rejectionReason ?? null,
      next.settledAt ?? null,
      next.blockedAt ?? null,
      next.revokedAt ?? null,
      next.pendingUntil ?? null,
      next.externalRef ?? null,
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

export async function registerAgentKey(
  walletId: string,
  publicKey: string,
  label: string,
): Promise<AgentKeyRecord> {
  const s = getStore();
  await s.ready;
  const record: AgentKeyRecord = {
    walletId,
    publicKey,
    label,
    createdAt: Date.now(),
  };
  await s.client.execute(
    "INSERT INTO agent_keys (wallet_id, public_key, label, created_at) VALUES (?, ?, ?, ?)",
    [walletId, publicKey, label, record.createdAt],
  );
  return record;
}

export async function getActiveAgentKey(
  walletId: string,
  publicKey: string,
): Promise<AgentKeyRecord | null> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute(
    "SELECT * FROM agent_keys WHERE wallet_id = ? AND public_key = ? AND revoked_at IS NULL",
    [walletId, publicKey],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    walletId: row.wallet_id as string,
    publicKey: row.public_key as string,
    label: row.label as string,
    createdAt: Number(row.created_at),
    revokedAt: row.revoked_at ? Number(row.revoked_at) : undefined,
  };
}

export async function listAgentKeys(walletId?: string): Promise<AgentKeyRecord[]> {
  const s = getStore();
  await s.ready;
  const { rows } = walletId
    ? await s.client.execute(
        "SELECT * FROM agent_keys WHERE wallet_id = ? ORDER BY created_at DESC",
        [walletId],
      )
    : await s.client.execute("SELECT * FROM agent_keys ORDER BY created_at DESC");
  return rows.map((r) => ({
    walletId: r.wallet_id as string,
    publicKey: r.public_key as string,
    label: r.label as string,
    createdAt: Number(r.created_at),
    revokedAt: r.revoked_at ? Number(r.revoked_at) : undefined,
  }));
}

export async function revokeAgentKey(
  walletId: string,
  publicKey: string,
): Promise<void> {
  const s = getStore();
  await s.ready;
  await s.client.execute(
    "UPDATE agent_keys SET revoked_at = ? WHERE wallet_id = ? AND public_key = ?",
    [Date.now(), walletId, publicKey],
  );
}

export { getStore };
export function getEvents() {
  return getStore().events;
}

/**
 * Multi-sig (2-of-3 by default): owner control-plane keys are only issued
 * after `MULTISIG_REQUIRED` distinct registered signers approve. Signers are
 * created by the master key; each authenticates with its own owner-scoped key
 * carrying `keyId`. The demo stays 1-of-1 at the rail; this protects key
 * issuance, the one operation that could give an attacker full control.
 */
export const MULTISIG_REQUIRED = Number(process.env.AEGIS_MULTISIG_REQUIRED ?? 2);
export const MULTISIG_TTL_MS = Number(process.env.AEGIS_MULTISIG_TTL_MS ?? 600000);

const DEFAULT_SIGNER_SEED: Array<{ name: string; role: SignerRole }> = [
  { name: "Ops Guard", role: "ops" },
  { name: "Treasury Guard", role: "treasury" },
  { name: "Admin Guard", role: "admin" },
];

function rowToSigner(row: Record<string, unknown>): Signer {
  return {
    id: row.id as string,
    name: row.name as string,
    role: row.role as SignerRole,
    enabled: Number(row.enabled) === 1,
    createdAt: Number(row.created_at),
  };
}

function rowToApproval(row: Record<string, unknown>): Approval {
  return {
    id: row.id as string,
    operation: row.operation as Approval["operation"],
    walletId: row.wallet_id as string,
    label: row.label as string,
    proposer: row.proposer as string,
    required: Number(row.required),
    approvers: JSON.parse(row.approvers as string) as string[],
    status: row.status as Approval["status"],
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    keyMinted: Number(row.key_minted) === 1,
  };
}

/** Creates the three demo signers the first time they are needed. */
export async function ensureDefaultSigners(): Promise<Signer[]> {
  const s = getStore();
  await s.ready;
  const existing = await listSigners();
  if (existing.length > 0) return existing;
  const created: Signer[] = [];
  for (const seed of DEFAULT_SIGNER_SEED) {
    created.push(await addSigner(seed.name, seed.role));
  }
  return created;
}

export async function listSigners(): Promise<Signer[]> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute("SELECT * FROM signers ORDER BY created_at ASC");
  return rows.map(rowToSigner);
}

export async function getSigner(id: string): Promise<Signer | null> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute("SELECT * FROM signers WHERE id = ?", [id]);
  const row = rows[0];
  return row ? rowToSigner(row) : null;
}

export async function addSigner(name: string, role: SignerRole): Promise<Signer> {
  const s = getStore();
  await s.ready;
  const signer: Signer = {
    id: randomUUID(),
    name,
    role,
    enabled: true,
    createdAt: Date.now(),
  };
  await s.client.execute(
    `INSERT INTO signers (id, name, role, enabled, created_at) VALUES (?, ?, ?, 1, ?)`,
    [signer.id, signer.name, signer.role, signer.createdAt],
  );
  return signer;
}

export async function removeSigner(id: string): Promise<boolean> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute("SELECT COUNT(*) AS n FROM signers WHERE id = ?", [id]);
  if (Number(rows[0]?.n ?? 0) === 0) return false;
  await s.client.execute("DELETE FROM signers WHERE id = ?", [id]);
  return true;
}

export async function listApprovals(): Promise<Approval[]> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute("SELECT * FROM approvals ORDER BY created_at DESC");
  return rows.map(rowToApproval);
}

export async function getApproval(id: string): Promise<Approval | null> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute("SELECT * FROM approvals WHERE id = ?", [id]);
  const row = rows[0];
  return row ? rowToApproval(row) : null;
}

export async function proposeApproval(input: {
  operation: Approval["operation"];
  walletId: string;
  label: string;
  proposer: string;
  required?: number;
}): Promise<Approval> {
  const s = getStore();
  await s.ready;
  const approval: Approval = {
    id: randomUUID(),
    operation: input.operation,
    walletId: input.walletId,
    label: input.label,
    proposer: input.proposer,
    required: input.required ?? MULTISIG_REQUIRED,
    approvers: [],
    status: "PENDING",
    createdAt: Date.now(),
    expiresAt: Date.now() + MULTISIG_TTL_MS,
    keyMinted: false,
  };
  await s.client.execute(
    `INSERT INTO approvals (id, operation, wallet_id, label, proposer, required, approvers, status, created_at, expires_at, key_minted)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, 0)`,
    [
      approval.id,
      approval.operation,
      approval.walletId,
      approval.label,
      approval.proposer,
      approval.required,
      JSON.stringify(approval.approvers),
      approval.createdAt,
      approval.expiresAt,
    ],
  );
  await addAudit({
    walletId: approval.walletId,
    actor: "owner",
    action: "MULTISIG_PROPOSED",
    details: `Requested ${approval.operation} for '${approval.label}' (needs ${approval.required} signers)`,
  });
  return approval;
}

/**
 * Records a signer's approval. When the threshold is reached the owner key is
 * minted exactly once and returned. Returns the updated approval and the key
 * (only to the caller that crossed the threshold).
 */
export async function approveApproval(
  id: string,
  signerId: string,
): Promise<{ approval: Approval; mintedKey?: string }> {
  const s = getStore();
  await s.ready;
  const approval = await getApproval(id);
  if (!approval) throw new Error("Approval not found");
  if (approval.status !== "PENDING") {
    throw new Error(`Approval already ${approval.status.toLowerCase()}`);
  }
  if (Date.now() > approval.expiresAt) {
    await s.client.execute("UPDATE approvals SET status = 'EXPIRED' WHERE id = ?", [id]);
    throw new Error("Approval expired");
  }
  const signer = await getSigner(signerId);
  if (!signer || !signer.enabled) throw new Error("Unknown or disabled signer");
  if (approval.approvers.includes(signerId)) throw new Error("Signer already approved");

  const approvers = [...approval.approvers, signerId];
  await addAudit({
    walletId: approval.walletId,
    actor: "owner",
    action: "MULTISIG_APPROVED",
    details: `${signer.name} (${signer.role}) approved ${approval.operation} for '${approval.label}' (${approvers.length}/${approval.required})`,
  });

  if (approvers.length < approval.required) {
    await s.client.execute(
      "UPDATE approvals SET approvers = ?, status = 'PENDING' WHERE id = ?",
      [JSON.stringify(approvers), id],
    );
    const updated = await getApproval(id);
    return { approval: updated! };
  }

  const mintedKey = await signKey(approval.walletId, "owner");
  await s.client.execute(
    "UPDATE approvals SET approvers = ?, status = 'APPROVED', key_minted = 1 WHERE id = ?",
    [JSON.stringify(approvers), id],
  );
  await addAudit({
    walletId: approval.walletId,
    actor: "system",
    action: "MULTISIG_OWNER_KEY_MINTED",
    details: `Owner key for '${approval.label}' minted after ${approvers.length}-of-${approval.required} signer approval`,
  });
  const updated = await getApproval(id);
  return { approval: updated!, mintedKey };
}

/** Rejects an open approval (any registered signer). */
export async function rejectApproval(id: string, signerId: string): Promise<Approval> {
  const s = getStore();
  await s.ready;
  const approval = await getApproval(id);
  if (!approval) throw new Error("Approval not found");
  if (approval.status !== "PENDING") {
    throw new Error(`Approval already ${approval.status.toLowerCase()}`);
  }
  await s.client.execute("UPDATE approvals SET status = 'REJECTED' WHERE id = ?", [id]);
  await addAudit({
    walletId: approval.walletId,
    actor: "owner",
    action: "MULTISIG_REJECTED",
    details: `Signer ${signerId} rejected ${approval.operation} for '${approval.label}'`,
  });
  const updated = await getApproval(id);
  return updated!;
}
