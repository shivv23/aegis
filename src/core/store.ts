import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createDb, type Db } from "./db";
import { encodeCursor, type Cursor } from "./pagination";
import type {
  Approval,
  AuditLogEntry,
  AgentKeyRecord,
  BudgetGroup,
  Counterparty,
  CounterpartyStatus,
  Escrow,
  EscrowStatus,
  Organization,
  OutboxEntry,
  PolicyVersion,
  PolicyVersionStatus,
  RejectionReason,
  Signer,
  SignerRole,
  TxStatus,
  Transaction,
  UsageRecord,
  Wallet,
  WalletPolicy,
  WalletStatus,
  WebhookDelivery,
  WebhookDeliveryStatus,
  WebhookEndpoint,
} from "./types";
import { assertTransition } from "./stateMachine";
import { appendLedgerRow, GENESIS_HASH, rechain, txContent, auditContent, verifyLedger as verifyChain } from "./ledger";
import { unitsFromFloat } from "./money";
import { decryptSecret, encryptSecret, secretsEnabled } from "./secrets";
import { getRail } from "./rails";
import { computeFee } from "./usage";
import { mergePolicy } from "./delegation";
import { signKey } from "./keys";
import { SEED_ORG_ID, SEED_VENDORS, SEED_WALLET_ID } from "./seed";
export const HOLD_MS = Number(process.env.AEGIS_HOLD_MS ?? 5000);

/** How long an owner has to approve/reject a high-risk transfer. */
export const STEP_UP_TTL_MS = Number(process.env.AEGIS_STEPUP_TTL_MS ?? 120000);

/** Circuit breaker: N guard anomalies within the window → auto-freeze. */
export const BREAKER_THRESHOLD = Number(process.env.AEGIS_BREAKER_THRESHOLD ?? 5);
export const BREAKER_WINDOW_MS = Number(process.env.AEGIS_BREAKER_WINDOW_MS ?? 60000);

const isDemoMode = () => process.env.AEGIS_DEMO_MODE !== "0";

/**
 * Opt-in demo seeding. When AEGIS_SEED_DEMO=1 the first boot (and a store
 * reset) provisions a demo org + wallet + a small fake history so the UI is
 * instantly explorable. Defaults to OFF so a production store contains only
 * data created through the real API.
 */
const seedDemoEnabled = () => process.env.AEGIS_SEED_DEMO === "1";

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
      spending_windows TEXT,
      region_allowlist TEXT,
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
      amount_units TEXT NOT NULL DEFAULT '0',
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
      revoked_at BIGINT,
      expires_at BIGINT,
      last_used_at BIGINT,
      acl TEXT
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
  await client.execute(`
    CREATE TABLE IF NOT EXISTS orgs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS counterparties (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      org_id TEXT,
      status TEXT NOT NULL,
      flags TEXT NOT NULL,
      total_paid REAL NOT NULL DEFAULT 0,
      total_tx INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS budget_groups (
      id TEXT PRIMARY KEY,
      org_id TEXT,
      name TEXT NOT NULL,
      monthly_limit REAL NOT NULL,
      created_at BIGINT NOT NULL
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS budget_group_wallets (
      group_id TEXT NOT NULL,
      wallet_id TEXT NOT NULL,
      PRIMARY KEY (group_id, wallet_id)
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS escrows (
      id TEXT PRIMARY KEY,
      wallet_id TEXT NOT NULL,
      "from" TEXT NOT NULL,
      "to" TEXT NOT NULL,
      amount REAL NOT NULL,
      condition TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      held_until BIGINT,
      released_at BIGINT,
      refunded_at BIGINT
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS usage (
      id TEXT PRIMARY KEY,
      wallet_id TEXT NOT NULL,
      org_id TEXT,
      tx_id TEXT NOT NULL,
      amount REAL NOT NULL,
      rail TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS secrets (
      id TEXT PRIMARY KEY,
      wallet_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      cipher TEXT NOT NULL,
      dek TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      UNIQUE (wallet_id, kind)
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
  if (!(await hasColumn(client, "wallets", "org_id"))) {
    await client.execute("ALTER TABLE wallets ADD COLUMN org_id TEXT");
  }
  if (!(await hasColumn(client, "wallets", "spending_windows"))) {
    await client.execute("ALTER TABLE wallets ADD COLUMN spending_windows TEXT");
    await client.execute("ALTER TABLE wallets ADD COLUMN region_allowlist TEXT");
  }
  if (!(await hasColumn(client, "agent_keys", "expires_at"))) {
    await client.execute("ALTER TABLE agent_keys ADD COLUMN expires_at BIGINT");
    await client.execute("ALTER TABLE agent_keys ADD COLUMN last_used_at BIGINT");
    await client.execute("ALTER TABLE agent_keys ADD COLUMN acl TEXT");
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

  // Versioned migrations: applied exactly once, in order, recorded in
  // schema_migrations so prod can evolve without drops.
  await applyMigrations(client);

  const { rows } = await client.execute("SELECT COUNT(*) AS n FROM wallets");
  if (Number(rows[0]?.n ?? 0) === 0 && seedDemoEnabled()) {
    await runSeed(client);
  }
}

interface Migration {
  version: number;
  name: string;
  up: (client: Db) => Promise<void>;
}

const MIGRATIONS: Migration[] = [
  {
    // Integer money on the ledger path: every transaction row gains an
    // amount_units column (integer units at display precision). The hash
    // chain already covers these units; this migration backfills the column
    // and rechains existing rows so verify() stays consistent. BOTH ledger
    // tables are rechained — transactions and audit share one interleaved
    // sequence, so touching one without the other breaks the chain.
    version: 3,
    name: "money-units",
    up: async (client) => {
      if (!(await hasColumn(client, "transactions", "amount_units"))) {
        await client.execute(
          "ALTER TABLE transactions ADD COLUMN amount_units TEXT NOT NULL DEFAULT '0'",
        );
      }
      const { rows: txs } = await client.execute(
        'SELECT id, amount FROM transactions',
      );
      for (const r of txs) {
        await client.execute(
          "UPDATE transactions SET amount_units = ? WHERE id = ?",
          [unitsFromFloat(Number(r.amount), 2).toString(), r.id],
        );
      }
      await rechain(client, ["transactions", "audit"]);
    },
  },
  {
    // Repair for v3: an early run rechained only `transactions`, which
    // desynced the shared transaction/audit sequence on existing databases.
    // Rechaining both tables restores a consistent interleaved chain.
    version: 4,
    name: "rechain-both",
    up: async (client) => {
      await rechain(client, ["transactions", "audit"]);
    },
  },
  {
    // Idempotency keys: transfer and escrow rows may carry a client-supplied
    // key so retries return the original result instead of double-settling.
    version: 5,
    name: "idempotency-keys",
    up: async (client) => {
      if (!(await hasColumn(client, "transactions", "idempotency_key"))) {
        await client.execute("ALTER TABLE transactions ADD COLUMN idempotency_key TEXT");
      }
      if (!(await hasColumn(client, "escrows", "idempotency_key"))) {
        await client.execute("ALTER TABLE escrows ADD COLUMN idempotency_key TEXT");
      }
    },
  },
  {
    // Self-serve webhook endpoints with a delivery log.
    version: 6,
    name: "webhook-console",
    up: async (client) => {
      await client.execute(`
        CREATE TABLE IF NOT EXISTS webhooks (
          id TEXT PRIMARY KEY,
          org_id TEXT,
          url TEXT NOT NULL,
          secret TEXT NOT NULL,
          event_types TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1,
          created_at BIGINT NOT NULL
        )
      `);
      await client.execute(`
        CREATE TABLE IF NOT EXISTS webhook_deliveries (
          id TEXT PRIMARY KEY,
          webhook_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          payload TEXT NOT NULL,
          status TEXT NOT NULL,
          http_status INTEGER,
          attempted_at BIGINT NOT NULL,
          delivered_at BIGINT
        )
      `);
    },
  },
  {
    // Full request audit (B4): every owner/agent API call with IP + user-agent.
    version: 7,
    name: "request-audit",
    up: async (client) => {
      await client.execute(`
        CREATE TABLE IF NOT EXISTS request_audit (
          id TEXT PRIMARY KEY,
          ts BIGINT NOT NULL,
          method TEXT NOT NULL,
          path TEXT NOT NULL,
          key_hash TEXT,
          scope TEXT,
          wallet_id TEXT,
          ip TEXT,
          user_agent TEXT,
          result TEXT NOT NULL
        )
      `);
    },
  },
  {
    // Magic-link sessions (1.1): owner identity in a revocable cookie session.
    version: 8,
    name: "auth-sessions",
    up: async (client) => {
      await client.execute(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          created_at BIGINT NOT NULL,
          last_used_at BIGINT NOT NULL,
          ip TEXT,
          user_agent TEXT,
          revoked_at BIGINT
        )
      `);
    },
  },
  {
    // Real settlement rails (A2) + reconciliation (A5).
    version: 9,
    name: "settlement-rails",
    up: async (client) => {
      if (!(await hasColumn(client, "transactions", "rail"))) {
        await client.execute("ALTER TABLE transactions ADD COLUMN rail TEXT");
      }
      if (!(await hasColumn(client, "wallets", "preferred_rail"))) {
        await client.execute("ALTER TABLE wallets ADD COLUMN preferred_rail TEXT");
      }
      await client.execute(`
        CREATE TABLE IF NOT EXISTS reconciliation_reports (
          id TEXT PRIMARY KEY,
          run_at BIGINT NOT NULL,
          total INTEGER NOT NULL,
          matched INTEGER NOT NULL,
          breaks INTEGER NOT NULL,
          details TEXT NOT NULL
        )
      `);
    },
  },
  {
    // Fee schedule + metering billing (A6): usage rows carry a rail fee and
    // invoice lines aggregate usage into per-wallet invoices.
    version: 10,
    name: "fee-billing",
    up: async (client) => {
      if (!(await hasColumn(client, "usage", "fee"))) {
        await client.execute("ALTER TABLE usage ADD COLUMN fee REAL NOT NULL DEFAULT 0");
      }
      await client.execute(`
        CREATE TABLE IF NOT EXISTS invoices (
          id TEXT PRIMARY KEY,
          wallet_id TEXT NOT NULL,
          period_start BIGINT NOT NULL,
          period_end BIGINT NOT NULL,
          status TEXT NOT NULL,
          total_usd REAL NOT NULL,
          total_fee_usd REAL NOT NULL,
          created_at BIGINT NOT NULL
        )
      `);
      await client.execute(`
        CREATE TABLE IF NOT EXISTS invoice_lines (
          invoice_id TEXT NOT NULL,
          rail TEXT NOT NULL,
          amount_usd REAL NOT NULL,
          fee_usd REAL NOT NULL,
          PRIMARY KEY (invoice_id, rail)
        )
      `);
    },
  },
  {
    // Delegation tree (D4): orgs and teams carry policy defaults that wallets
    // inherit. The guard runs against the merged (effective) policy.
    version: 11,
    name: "delegation-tree",
    up: async (client) => {
      if (!(await hasColumn(client, "orgs", "policy"))) {
        await client.execute("ALTER TABLE orgs ADD COLUMN policy TEXT");
      }
      if (!(await hasColumn(client, "budget_groups", "policy"))) {
        await client.execute("ALTER TABLE budget_groups ADD COLUMN policy TEXT");
      }
    },
  },
  {
    // Backfill for databases seeded before the orgs feature existed: attach
    // the seed wallet to the Acme Labs org. Skipped on fresh databases where
    // runSeed() (which runs after migrations) creates both correctly.
    version: 12,
    name: "seed-org-backfill",
    up: async (client) => {
      const { rows } = await client.execute("SELECT COUNT(*) AS n FROM wallets");
      if (Number(rows[0]?.n ?? 0) === 0) return;
      await client.execute(
        "INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING",
        [SEED_ORG_ID, "Acme Labs", Date.now()],
      );
      await client.execute(
        "UPDATE wallets SET org_id = ? WHERE id = ?",
        [SEED_ORG_ID, SEED_WALLET_ID],
      );
    },
  },
  {
    // Platform ops (C7 kill switches, D6 insurance pools, E6 settings,
    // D2 DID registry, E2 report log). Idempotent CREATE IF NOT EXISTS so a
    // partially applied upgrade is safe to re-run.
    version: 13,
    name: "platform-ops",
    up: async (client) => {
      await client.execute(`
        CREATE TABLE IF NOT EXISTS kill_switches (
          org_id TEXT PRIMARY KEY,
          reason TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          set_at BIGINT NOT NULL
        )
      `);
      await client.execute(`
        CREATE TABLE IF NOT EXISTS insurance_pools (
          id TEXT PRIMARY KEY,
          org_id TEXT,
          name TEXT NOT NULL,
          capacity REAL NOT NULL,
          loss_cap REAL NOT NULL,
          deployed REAL NOT NULL DEFAULT 0,
          created_at BIGINT NOT NULL
        )
      `);
      await client.execute(`
        CREATE TABLE IF NOT EXISTS user_settings (
          owner TEXT PRIMARY KEY,
          currency TEXT NOT NULL DEFAULT 'USD',
          timezone TEXT NOT NULL DEFAULT 'UTC',
          updated_at BIGINT NOT NULL
        )
      `);
      await client.execute(`
        CREATE TABLE IF NOT EXISTS did_registry (
          did TEXT PRIMARY KEY,
          doc TEXT NOT NULL,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL
        )
      `);
      await client.execute(`
        CREATE TABLE IF NOT EXISTS report_log (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          channel TEXT NOT NULL,
          summary TEXT NOT NULL,
          created_at BIGINT NOT NULL
        )
      `);
    },
  },
  {
    // Auth hardening (P2-2): a denylist for revoked API keys so sign-out can
    // actually kill a leaked owner key, and a one-time-use ledger for magic
    // link tokens so a captured link cannot be replayed.
    version: 14,
    name: "auth-hardening",
    up: async (client) => {
      await client.execute(`
        CREATE TABLE IF NOT EXISTS revoked_keys (
          key_hash TEXT PRIMARY KEY,
          scope TEXT,
          revoked_at BIGINT NOT NULL
        )
      `);
      await client.execute(`
        CREATE TABLE IF NOT EXISTS magic_tokens (
          jti TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          used_at BIGINT NOT NULL
        )
      `);
    },
  },
];

async function applyMigrations(client: Db): Promise<void> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at BIGINT NOT NULL
    )
  `);
  const { rows } = await client.execute(
    "SELECT version FROM schema_migrations ORDER BY version",
  );
  const applied = new Set(rows.map((r) => Number(r.version)));
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    await migration.up(client);
    await client.execute(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      [migration.version, migration.name, Date.now()],
    );
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
    `INSERT INTO orgs (id, name, created_at)
     VALUES (?, ?, ?)`,
    [SEED_ORG_ID, "Acme Labs", now - 30 * dayMs],
  );

  await client.execute(
    `INSERT INTO wallets (id, name, owner_did, status, balance, max_per_tx, daily_limit, monthly_limit, velocity_limit_per_min, allowlist, created_at, org_id)
     VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      SEED_ORG_ID,
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
      amountUnits: unitsFromFloat(h.amount, 2).toString(),
      purpose: h.purpose,
      nonce,
      requestedAt: settledAt,
    });
    await appendLedgerRow(
      client,
      "transactions",
      ["id", "wallet_id", "from", "to", "amount", "amount_units", "purpose", "status", "rejection_reason", "requested_at", "pending_until", "settled_at", "blocked_at", "revoked_at", "nonce"],
      [
        randomUUID(),
        SEED_WALLET_ID,
        SEED_WALLET_ID,
        h.to,
        h.amount,
        unitsFromFloat(h.amount, 2).toString(),
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

export async function resetStore(options: { reseed?: boolean } = {}): Promise<Wallet[]> {
  const reseed = options.reseed ?? seedDemoEnabled();
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
  await s.client.execute("DELETE FROM counterparties");
  await s.client.execute("DELETE FROM budget_group_wallets");
  await s.client.execute("DELETE FROM budget_groups");
  await s.client.execute("DELETE FROM escrows");
  await s.client.execute("DELETE FROM usage");
  await s.client.execute("DELETE FROM secrets");
  await s.client.execute("DELETE FROM orgs");
  await s.client.execute("DELETE FROM sessions");
  await s.client.execute(
    "UPDATE ledger_state SET head_hash = ?, row_count = 0 WHERE id = 1",
    [GENESIS_HASH],
  );
  if (reseed) await runSeed(s.client);
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
  // Best-effort push alert; never awaited so it cannot block the money path.
  void import("./push").then(({ deliverAlert }) => deliverAlert(entry));
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
      spendingWindows: row.spending_windows
        ? (JSON.parse(row.spending_windows as string) as WalletPolicy["spendingWindows"])
        : undefined,
      regionAllowlist: row.region_allowlist
        ? (JSON.parse(row.region_allowlist as string) as string[])
        : undefined,
    },
    createdAt: Number(row.created_at),
    orgId: row.org_id ? (row.org_id as string) : undefined,
    preferredRail: row.preferred_rail ? (row.preferred_rail as string) : undefined,
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
    rail: row.rail ? (row.rail as string) : undefined,
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

/** Sets the settlement rail a wallet prefers (A2). */
export async function setWalletPreferredRail(
  id: string,
  rail: string,
): Promise<Wallet | null> {
  const s = getStore();
  await s.ready;
  await s.client.execute("UPDATE wallets SET preferred_rail = ? WHERE id = ?", [rail, id]);
  const wallet = await getWallet(id);
  if (wallet) s.events.emit("wallet", wallet);
  return wallet;
}

export async function createWallet(input: {
  id: string;
  name: string;
  ownerDid: string;
  balance: number;
  policy: WalletPolicy;
  orgId?: string;
  preferredRail?: string;
}): Promise<Wallet> {
  const s = getStore();
  await s.ready;
  await s.client.execute(
    `INSERT INTO wallets (id, name, owner_did, status, balance, max_per_tx, daily_limit, monthly_limit, velocity_limit_per_min, allowlist, spending_windows, region_allowlist, created_at, org_id, preferred_rail)
     VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      input.policy.spendingWindows ? JSON.stringify(input.policy.spendingWindows) : null,
      input.policy.regionAllowlist ? JSON.stringify(input.policy.regionAllowlist) : null,
      Date.now(),
      input.orgId ?? null,
      input.preferredRail ?? null,
    ],
  );
  const wallet = await getWallet(input.id);
  if (!wallet) throw new Error("Failed to create wallet");
  await createPolicyVersion(input.id, input.policy, "owner");
  s.events.emit("wallet", wallet);
  return wallet;
}

export async function createOrg(name: string): Promise<Organization> {
  const s = getStore();
  await s.ready;
  const org: Organization = {
    id: `org-${randomUUID().slice(0, 8)}`,
    name,
    createdAt: Date.now(),
  };
  await s.client.execute("INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)", [
    org.id,
    org.name,
    org.createdAt,
  ]);
  return org;
}

export async function listOrgs(): Promise<Organization[]> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute("SELECT * FROM orgs ORDER BY created_at ASC");
  return rows.map((r) => rowToOrg(r as Record<string, unknown>));
}

function rowToOrg(row: Record<string, unknown>): Organization {
  return {
    id: row.id as string,
    name: row.name as string,
    createdAt: Number(row.created_at),
    policy: row.policy ? (JSON.parse(row.policy as string) as WalletPolicy) : undefined,
  };
}

export async function getOrg(id: string): Promise<Organization | null> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute("SELECT * FROM orgs WHERE id = ?", [id]);
  const row = rows[0];
  return row ? rowToOrg(row as Record<string, unknown>) : null;
}

/** Sets the org-level default policy (D4). Wallet/team policies cap these. */
export async function updateOrgPolicy(orgId: string, policy: WalletPolicy): Promise<Organization | null> {
  const s = getStore();
  await s.ready;
  await s.client.execute("UPDATE orgs SET policy = ? WHERE id = ?", [JSON.stringify(policy), orgId]);
  return getOrg(orgId);
}

export async function listOrgWallets(orgId: string): Promise<Wallet[]> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute(
    "SELECT * FROM wallets WHERE org_id = ? ORDER BY created_at ASC",
    [orgId],
  );
  return rows.map((r) => rowToWallet(r as Record<string, unknown>));
}

// ─── Counterparty registry ────────────────────────────────────────────────

function rowToCounterparty(row: Record<string, unknown>): Counterparty {
  return {
    id: row.id as string,
    name: row.name as string,
    address: row.address as string,
    orgId: row.org_id ? (row.org_id as string) : undefined,
    status: row.status as CounterpartyStatus,
    flags: JSON.parse(row.flags as string) as string[],
    totalPaid: Number(row.total_paid),
    totalTx: Number(row.total_tx),
    createdAt: Number(row.created_at),
  };
}

export async function listCounterparties(orgId?: string): Promise<Counterparty[]> {
  const s = getStore();
  await s.ready;
  const { rows } = orgId
    ? await s.client.execute("SELECT * FROM counterparties WHERE org_id = ? ORDER BY created_at ASC", [orgId])
    : await s.client.execute("SELECT * FROM counterparties ORDER BY created_at ASC");
  return rows.map((r) => rowToCounterparty(r as Record<string, unknown>));
}

export async function getCounterparty(address: string): Promise<Counterparty | null> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute("SELECT * FROM counterparties WHERE address = ?", [address]);
  const row = rows[0];
  return row ? rowToCounterparty(row as Record<string, unknown>) : null;
}

export async function upsertCounterparty(input: {
  name: string;
  address: string;
  orgId?: string;
  status?: CounterpartyStatus;
  flags?: string[];
}): Promise<Counterparty> {
  const s = getStore();
  await s.ready;
  const existing = await getCounterparty(input.address);
  if (existing) {
    await s.client.execute(
      "UPDATE counterparties SET name = ?, status = ?, flags = ? WHERE address = ?",
      [
        input.name,
        input.status ?? existing.status,
        JSON.stringify(input.flags ?? existing.flags),
        input.address,
      ],
    );
    const { rows } = await s.client.execute("SELECT * FROM counterparties WHERE address = ?", [input.address]);
    return rowToCounterparty(rows[0] as Record<string, unknown>);
  }
  const cp: Counterparty = {
    id: `cp-${randomUUID().slice(0, 8)}`,
    name: input.name,
    address: input.address,
    orgId: input.orgId,
    status: input.status ?? "ACTIVE",
    flags: input.flags ?? [],
    totalPaid: 0,
    totalTx: 0,
    createdAt: Date.now(),
  };
  await s.client.execute(
    "INSERT INTO counterparties (id, name, address, org_id, status, flags, total_paid, total_tx, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)",
    [cp.id, cp.name, cp.address, cp.orgId ?? null, cp.status, JSON.stringify(cp.flags), cp.createdAt],
  );
  return cp;
}

/** Records a settled amount against a counterparty for reputation totals. */
export async function recordCounterpartyPayment(
  address: string,
  amount: number,
): Promise<void> {
  const s = getStore();
  await s.ready;
  const cp = await getCounterparty(address);
  if (!cp) return;
  await s.client.execute(
    "UPDATE counterparties SET total_paid = total_paid + ?, total_tx = total_tx + 1 WHERE address = ?",
    [amount, address],
  );
}

// ─── Budget groups ────────────────────────────────────────────────────────

function rowToBudgetGroup(row: Record<string, unknown>, walletIds: string[]): BudgetGroup {
  return {
    id: row.id as string,
    orgId: row.org_id ? (row.org_id as string) : undefined,
    name: row.name as string,
    monthlyLimit: Number(row.monthly_limit),
    walletIds,
    createdAt: Number(row.created_at),
    policy: row.policy ? (JSON.parse(row.policy as string) as WalletPolicy) : undefined,
  };
}

/** Sets the team-level policy (D4). Wallet overrides can only tighten it. */
export async function updateTeamPolicy(groupId: string, policy: WalletPolicy): Promise<BudgetGroup | null> {
  const s = getStore();
  await s.ready;
  await s.client.execute("UPDATE budget_groups SET policy = ? WHERE id = ?", [JSON.stringify(policy), groupId]);
  const group = await getBudgetGroupForWalletById(groupId);
  return group;
}

async function getBudgetGroupForWalletById(groupId: string): Promise<BudgetGroup | null> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute("SELECT * FROM budget_groups WHERE id = ?", [groupId]);
  const row = rows[0];
  if (!row) return null;
  return rowToBudgetGroup(row as Record<string, unknown>, await groupWalletIds(s.client, groupId));
}

/**
 * D4: resolves a wallet's effective policy by merging org → team → wallet.
 * Returns the wallet with a resolved policy (and the per-field source) ready
 * for the guard.
 */
export async function resolveEffectiveWallet(walletId: string): Promise<Wallet | null> {
  const s = getStore();
  await s.ready;
  const wallet = await getWallet(walletId);
  if (!wallet) return null;
  const orgPolicy = wallet.orgId ? (await getOrg(wallet.orgId))?.policy : undefined;
  const group = await getBudgetGroupForWallet(walletId);
  const teamPolicy = group?.policy;
  const { policy, sources } = mergePolicy(wallet.policy, orgPolicy, teamPolicy);
  return { ...wallet, policy, effectiveSources: sources };
}

async function groupWalletIds(client: Db, groupId: string): Promise<string[]> {
  const { rows } = await client.execute(
    "SELECT wallet_id FROM budget_group_wallets WHERE group_id = ?",
    [groupId],
  );
  return rows.map((r) => r.wallet_id as string);
}

export async function listBudgetGroups(orgId?: string): Promise<BudgetGroup[]> {
  const s = getStore();
  await s.ready;
  const { rows } = orgId
    ? await s.client.execute("SELECT * FROM budget_groups WHERE org_id = ? ORDER BY created_at ASC", [orgId])
    : await s.client.execute("SELECT * FROM budget_groups ORDER BY created_at ASC");
  const out: BudgetGroup[] = [];
  for (const row of rows) {
    out.push(rowToBudgetGroup(row as Record<string, unknown>, await groupWalletIds(s.client, row.id as string)));
  }
  return out;
}

export async function getBudgetGroupForWallet(walletId: string): Promise<BudgetGroup | null> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute(
    "SELECT g.* FROM budget_groups g JOIN budget_group_wallets m ON m.group_id = g.id WHERE m.wallet_id = ?",
    [walletId],
  );
  const row = rows[0];
  if (!row) return null;
  return rowToBudgetGroup(row as Record<string, unknown>, await groupWalletIds(s.client, row.id as string));
}

export async function createBudgetGroup(input: {
  name: string;
  monthlyLimit: number;
  orgId?: string;
  walletIds?: string[];
}): Promise<BudgetGroup> {
  const s = getStore();
  await s.ready;
  const group: BudgetGroup = {
    id: `bg-${randomUUID().slice(0, 8)}`,
    orgId: input.orgId,
    name: input.name,
    monthlyLimit: input.monthlyLimit,
    walletIds: input.walletIds ?? [],
    createdAt: Date.now(),
  };
  await s.client.execute(
    "INSERT INTO budget_groups (id, org_id, name, monthly_limit, created_at) VALUES (?, ?, ?, ?, ?)",
    [group.id, group.orgId ?? null, group.name, group.monthlyLimit, group.createdAt],
  );
  for (const wid of group.walletIds) {
    await s.client.execute("INSERT INTO budget_group_wallets (group_id, wallet_id) VALUES (?, ?) ON CONFLICT (group_id, wallet_id) DO NOTHING", [group.id, wid]);
  }
  return group;
}

export async function addWalletToBudgetGroup(groupId: string, walletId: string): Promise<void> {
  const s = getStore();
  await s.ready;
  await s.client.execute("INSERT INTO budget_group_wallets (group_id, wallet_id) VALUES (?, ?) ON CONFLICT (group_id, wallet_id) DO NOTHING", [groupId, walletId]);
}

/** Sum of SETTLED + PENDING spend across a group's wallets in the last 30 days. */
export async function groupSpendLast30d(group: BudgetGroup, now = Date.now()): Promise<number> {
  const s = getStore();
  await s.ready;
  const monthMs = 30 * 24 * 60 * 60 * 1000;
  let total = 0;
  for (const walletId of group.walletIds) {
    const { rows } = await s.client.execute(
      "SELECT amount, status, settled_at, requested_at FROM transactions WHERE wallet_id = ? AND status IN ('SETTLED','PENDING')",
      [walletId],
    );
    for (const r of rows) {
      const when = r.status === "SETTLED" ? Number(r.settled_at) : Number(r.requested_at);
      if (now - when < monthMs) total += Number(r.amount);
    }
  }
  return total;
}

// ─── Escrows ──────────────────────────────────────────────────────────────

function rowToEscrow(row: Record<string, unknown>): Escrow {
  return {
    id: row.id as string,
    walletId: row.wallet_id as string,
    from: row.from as string,
    to: row.to as string,
    amount: Number(row.amount),
    condition: row.condition as string,
    status: row.status as EscrowStatus,
    createdAt: Number(row.created_at),
    heldUntil: row.held_until ? Number(row.held_until) : undefined,
    releasedAt: row.released_at ? Number(row.released_at) : undefined,
    refundedAt: row.refunded_at ? Number(row.refunded_at) : undefined,
  };
}

export async function createEscrow(input: {
  walletId: string;
  to: string;
  amount: number;
  condition: string;
  heldUntil?: number;
  idempotencyKey?: string;
}): Promise<Escrow> {
  const s = getStore();
  await s.ready;
  if (input.idempotencyKey) {
    const existing = await findEscrowByIdempotencyKey(input.idempotencyKey);
    if (existing) return existing;
  }
  const escrow: Escrow = {
    id: `esc-${randomUUID().slice(0, 8)}`,
    walletId: input.walletId,
    from: input.walletId,
    to: input.to,
    amount: input.amount,
    condition: input.condition,
    status: "HELD",
    createdAt: Date.now(),
    heldUntil: input.heldUntil,
  };
  await s.client.execute(
    "INSERT INTO escrows (id, wallet_id, \"from\", \"to\", amount, condition, status, created_at, held_until, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, 'HELD', ?, ?, ?)",
    [escrow.id, escrow.walletId, escrow.from, escrow.to, escrow.amount, escrow.condition, escrow.createdAt, escrow.heldUntil ?? null, input.idempotencyKey ?? null],
  );
  await debitWallet(escrow.walletId, escrow.amount);
  await addAudit({
    walletId: escrow.walletId,
    actor: "owner",
    action: "ESCROW_CREATED",
    details: `${escrow.amount} escrowed to ${escrow.to} until condition: ${escrow.condition}`,
  });
  return escrow;
}

export async function findTransactionByIdempotencyKey(
  key: string,
): Promise<Transaction | null> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute(
    "SELECT * FROM transactions WHERE idempotency_key = ? LIMIT 1",
    [key],
  );
  if (rows.length === 0) return null;
  return rowToTransaction(rows[0] as Record<string, unknown>);
}

export async function findEscrowByIdempotencyKey(
  key: string,
): Promise<Escrow | null> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute(
    "SELECT * FROM escrows WHERE idempotency_key = ? LIMIT 1",
    [key],
  );
  if (rows.length === 0) return null;
  return rowToEscrow(rows[0] as Record<string, unknown>);
}

export async function releaseEscrow(id: string, actor = "owner"): Promise<Escrow | null> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute("SELECT * FROM escrows WHERE id = ?", [id]);
  const row = rows[0];
  if (!row) return null;
  const escrow = rowToEscrow(row as Record<string, unknown>);
  if (escrow.status !== "HELD") return escrow;
  await s.client.execute("UPDATE escrows SET status = 'RELEASED', released_at = ? WHERE id = ?", [Date.now(), id]);
  await addAudit({
    walletId: escrow.walletId,
    actor: actor as AuditLogEntry["actor"],
    action: "ESCROW_RELEASED",
    details: `Escrow ${id.slice(0, 8)} released to ${escrow.to}`,
  });
  return { ...escrow, status: "RELEASED", releasedAt: Date.now() };
}

export async function refundEscrow(id: string, actor = "owner"): Promise<Escrow | null> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute("SELECT * FROM escrows WHERE id = ?", [id]);
  const row = rows[0];
  if (!row) return null;
  const escrow = rowToEscrow(row as Record<string, unknown>);
  if (escrow.status !== "HELD") return escrow;
  await s.client.execute("UPDATE escrows SET status = 'REFUNDED', refunded_at = ? WHERE id = ?", [Date.now(), id]);
  await creditWallet(escrow.walletId, escrow.amount);
  await addAudit({
    walletId: escrow.walletId,
    actor: actor as AuditLogEntry["actor"],
    action: "ESCROW_REFUNDED",
    details: `Escrow ${id.slice(0, 8)} refunded ${escrow.amount}`,
  });
  return { ...escrow, status: "REFUNDED", refundedAt: Date.now() };
}

export async function listEscrows(walletId?: string): Promise<Escrow[]> {
  const s = getStore();
  await s.ready;
  const { rows } = walletId
    ? await s.client.execute("SELECT * FROM escrows WHERE wallet_id = ? ORDER BY created_at DESC", [walletId])
    : await s.client.execute("SELECT * FROM escrows ORDER BY created_at DESC");
  return rows.map((r) => rowToEscrow(r as Record<string, unknown>));
}

// ─── Usage metering ───────────────────────────────────────────────────────

export async function recordUsage(input: {
  walletId: string;
  orgId?: string;
  txId: string;
  amount: number;
  rail: string;
  fee?: number;
}): Promise<UsageRecord> {
  const s = getStore();
  await s.ready;
  const fee = input.fee ?? computeFee(input.rail, input.amount);
  const record: UsageRecord = {
    id: randomUUID(),
    walletId: input.walletId,
    orgId: input.orgId,
    txId: input.txId,
    amount: input.amount,
    fee,
    rail: input.rail,
    createdAt: Date.now(),
  };
  await s.client.execute(
    "INSERT INTO usage (id, wallet_id, org_id, tx_id, amount, fee, rail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [record.id, record.walletId, record.orgId ?? null, record.txId, record.amount, record.fee, record.rail, record.createdAt],
  );
  return record;
}

export async function listUsage(walletId?: string): Promise<UsageRecord[]> {
  const s = getStore();
  await s.ready;
  const { rows } = walletId
    ? await s.client.execute("SELECT * FROM usage WHERE wallet_id = ? ORDER BY created_at DESC LIMIT 500", [walletId])
    : await s.client.execute("SELECT * FROM usage ORDER BY created_at DESC LIMIT 500");
  return rows.map((r) => ({
    id: r.id as string,
    walletId: r.wallet_id as string,
    orgId: r.org_id ? (r.org_id as string) : undefined,
    txId: r.tx_id as string,
    amount: Number(r.amount),
    fee: Number(r.fee ?? 0),
    rail: r.rail as string,
    createdAt: Number(r.created_at),
  }));
}

// ─── Cursor pagination (C1) ────────────────────────────────────────────────

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Keyset page: rows strictly older than the cursor's (orderCol, id) pair,
 * newest first. Returns limit+1 rows to detect a next page cheaply.
 */
async function runPage<T>(
  opts: {
    table: string;
    orderCol: string;
    idCol?: string;
    walletId?: string;
    search?: string;
    limit: number;
    cursor: Cursor | null;
    map: (row: Record<string, unknown>) => T;
  },
): Promise<Page<T>> {
  const s = getStore();
  await s.ready;
  const idCol = opts.idCol ?? "id";
  const params: unknown[] = [];
  let where = "1=1";
  if (opts.walletId) {
    where += " AND wallet_id = ?";
    params.push(opts.walletId);
  }
  if (opts.search) {
    const q = `%${opts.search}%`;
    where += " AND (action LIKE ? OR details LIKE ? OR wallet_id LIKE ?)";
    params.push(q, q, q);
  }
  if (opts.cursor) {
    where += ` AND (${opts.orderCol} < ? OR (${opts.orderCol} = ? AND ${idCol} < ?))`;
    params.push(opts.cursor.at, opts.cursor.at, opts.cursor.id);
  }
  const { rows } = await s.client.execute(
    `SELECT * FROM ${opts.table} WHERE ${where} ORDER BY ${opts.orderCol} DESC, ${idCol} DESC LIMIT ?`,
    [...params, opts.limit + 1],
  );
  const hasMore = rows.length > opts.limit;
  const pageRows = hasMore ? rows.slice(0, opts.limit) : rows;
  const items = pageRows.map((r) => opts.map(r as Record<string, unknown>));
  const last = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(Number(last[opts.orderCol]), String(last[idCol])) : null;
  return { items, nextCursor };
}

export async function listTransactionsPage(opts: {
  walletId?: string;
  limit: number;
  cursor: Cursor | null;
}): Promise<Page<Transaction>> {
  return runPage<Transaction>({ table: "transactions", orderCol: "requested_at", ...opts, map: (r) => rowToTransaction(r) });
}

export async function listAuditPage(opts: {
  walletId?: string;
  search?: string;
  limit: number;
  cursor: Cursor | null;
}): Promise<Page<AuditLogEntry>> {
  return runPage<AuditLogEntry>({ table: "audit", orderCol: "timestamp", ...opts, map: (r) => rowToAudit(r) });
}

export async function listOutboxPage(opts: {
  walletId?: string;
  limit: number;
  cursor: Cursor | null;
}): Promise<Page<OutboxEntry>> {
  return runPage<OutboxEntry>({
    table: "outbox",
    orderCol: "created_at",
    ...opts,
    map: (r) => ({
      id: r.id as string,
      walletId: r.wallet_id as string,
      eventType: r.event_type as string,
      payload: r.payload as string,
      createdAt: Number(r.created_at),
      deliveredAt: r.delivered_at ? Number(r.delivered_at) : undefined,
      attemptCount: Number(r.attempt_count),
    }),
  });
}

export async function listUsagePage(opts: {
  walletId?: string;
  limit: number;
  cursor: Cursor | null;
}): Promise<Page<UsageRecord>> {
  return runPage<UsageRecord>({
    table: "usage",
    orderCol: "created_at",
    ...opts,
    map: (r) => ({
      id: r.id as string,
      walletId: r.wallet_id as string,
      orgId: r.org_id ? (r.org_id as string) : undefined,
      txId: r.tx_id as string,
      amount: Number(r.amount),
      fee: Number(r.fee ?? 0),
      rail: r.rail as string,
      createdAt: Number(r.created_at),
    }),
  });
}

export interface StoredSecretMeta {
  id: string;
  walletId: string;
  kind: string;
  createdAt: number;
}

/**
 * Stores a secret encrypted at rest (envelope encryption). Returns the record
 * or null when no master key is configured (secrets disabled).
 */
export async function putSecret(
  walletId: string,
  kind: string,
  plaintext: string,
): Promise<StoredSecretMeta | null> {
  const s = getStore();
  await s.ready;
  if (!(await secretsEnabled())) return null;
  const { cipher, dek } = await encryptSecret(plaintext);
  const id = randomUUID();
  const now = Date.now();
  await s.client.execute(
    `INSERT INTO secrets (id, wallet_id, kind, cipher, dek, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (wallet_id, kind) DO UPDATE SET cipher = excluded.cipher, dek = excluded.dek, created_at = excluded.created_at`,
    [id, walletId, kind, cipher, dek, now],
  );
  return { id, walletId, kind, createdAt: now };
}

/** Decrypts a stored secret. Null if missing, tampered, or secrets disabled. */
export async function getSecret(walletId: string, kind: string): Promise<string | null> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute(
    "SELECT cipher, dek FROM secrets WHERE wallet_id = ? AND kind = ?",
    [walletId, kind],
  );
  if (rows.length === 0) return null;
  return decryptSecret({ cipher: rows[0].cipher as string, dek: rows[0].dek as string });
}

/** Lists which secrets exist for a wallet — metadata only, never ciphertext. */
export async function listSecretMeta(walletId?: string): Promise<StoredSecretMeta[]> {
  const s = getStore();
  await s.ready;
  const { rows } = walletId
    ? await s.client.execute("SELECT id, wallet_id, kind, created_at FROM secrets WHERE wallet_id = ? ORDER BY created_at DESC", [walletId])
    : await s.client.execute("SELECT id, wallet_id, kind, created_at FROM secrets ORDER BY created_at DESC");
  return rows.map((r) => ({
    id: r.id as string,
    walletId: r.wallet_id as string,
    kind: r.kind as string,
    createdAt: Number(r.created_at),
  }));
}

export async function deleteSecret(walletId: string, kind: string): Promise<void> {
  const s = getStore();
  await s.ready;
  await s.client.execute(
    "DELETE FROM secrets WHERE wallet_id = ? AND kind = ?",
    [walletId, kind],
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Self-serve webhooks (E1)
// ────────────────────────────────────────────────────────────────────────────

export async function createWebhook(input: {
  url: string;
  secret: string;
  eventTypes: string[];
  orgId?: string;
}): Promise<WebhookEndpoint> {
  const s = getStore();
  await s.ready;
  const endpoint: WebhookEndpoint = {
    id: randomUUID(),
    orgId: input.orgId,
    url: input.url,
    secret: input.secret,
    eventTypes: input.eventTypes,
    active: true,
    createdAt: Date.now(),
  };
  await s.client.execute(
    "INSERT INTO webhooks (id, org_id, url, secret, event_types, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
    [endpoint.id, endpoint.orgId ?? null, endpoint.url, endpoint.secret, JSON.stringify(endpoint.eventTypes), endpoint.createdAt],
  );
  return endpoint;
}

export async function listWebhooks(orgId?: string): Promise<WebhookEndpoint[]> {
  const s = getStore();
  await s.ready;
  const { rows } = orgId
    ? await s.client.execute("SELECT * FROM webhooks WHERE org_id = ? ORDER BY created_at DESC", [orgId])
    : await s.client.execute("SELECT * FROM webhooks ORDER BY created_at DESC");
  return rows.map(rowToWebhook);
}

export async function getWebhook(id: string): Promise<WebhookEndpoint | null> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute("SELECT * FROM webhooks WHERE id = ?", [id]);
  if (rows.length === 0) return null;
  return rowToWebhook(rows[0] as Record<string, unknown>);
}

export async function updateWebhook(
  id: string,
  patch: { url?: string; secret?: string; eventTypes?: string[]; active?: boolean },
): Promise<WebhookEndpoint | null> {
  const s = getStore();
  await s.ready;
  const existing = await getWebhook(id);
  if (!existing) return null;
  const next: WebhookEndpoint = {
    ...existing,
    url: patch.url ?? existing.url,
    secret: patch.secret ?? existing.secret,
    eventTypes: patch.eventTypes ?? existing.eventTypes,
    active: patch.active ?? existing.active,
  };
  await s.client.execute(
    "UPDATE webhooks SET url = ?, secret = ?, event_types = ?, active = ? WHERE id = ?",
    [next.url, next.secret, JSON.stringify(next.eventTypes), next.active ? 1 : 0, id],
  );
  return next;
}

export async function deleteWebhook(id: string): Promise<void> {
  const s = getStore();
  await s.ready;
  await s.client.execute("DELETE FROM webhooks WHERE id = ?", [id]);
  await s.client.execute("DELETE FROM webhook_deliveries WHERE webhook_id = ?", [id]);
}

export async function listWebhookDeliveries(
  webhookId: string,
  limit = 50,
): Promise<WebhookDelivery[]> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute(
    "SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY attempted_at DESC LIMIT ?",
    [webhookId, limit],
  );
  return rows.map(rowToDelivery);
}

export async function getWebhookDelivery(id: string): Promise<WebhookDelivery | null> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute("SELECT * FROM webhook_deliveries WHERE id = ?", [id]);
  if (rows.length === 0) return null;
  return rowToDelivery(rows[0] as Record<string, unknown>);
}

export async function recordWebhookDelivery(
  webhookId: string,
  eventType: string,
  payload: unknown,
  status: WebhookDeliveryStatus,
  httpStatus?: number,
): Promise<WebhookDelivery> {
  const s = getStore();
  await s.ready;
  const delivery: WebhookDelivery = {
    id: randomUUID(),
    webhookId,
    eventType,
    payload: typeof payload === "string" ? payload : JSON.stringify(payload),
    status,
    httpStatus,
    attemptedAt: Date.now(),
    deliveredAt: status === "DELIVERED" ? Date.now() : undefined,
  };
  await s.client.execute(
    "INSERT INTO webhook_deliveries (id, webhook_id, event_type, payload, status, http_status, attempted_at, delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [delivery.id, webhookId, eventType, delivery.payload, status, httpStatus ?? null, delivery.attemptedAt, delivery.deliveredAt ?? null],
  );
  return delivery;
}

function rowToWebhook(r: Record<string, unknown>): WebhookEndpoint {
  return {
    id: r.id as string,
    orgId: r.org_id ? (r.org_id as string) : undefined,
    url: r.url as string,
    secret: r.secret as string,
    eventTypes: JSON.parse(r.event_types as string) as string[],
    active: Number(r.active) === 1,
    createdAt: Number(r.created_at),
  };
}

function rowToDelivery(r: Record<string, unknown>): WebhookDelivery {
  return {
    id: r.id as string,
    webhookId: r.webhook_id as string,
    eventType: r.event_type as string,
    payload: r.payload as string,
    status: r.status as WebhookDeliveryStatus,
    httpStatus: r.http_status ? Number(r.http_status) : undefined,
    attemptedAt: Number(r.attempted_at),
    deliveredAt: r.delivered_at ? Number(r.delivered_at) : undefined,
  };
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
      "UPDATE wallets SET max_per_tx = ?, daily_limit = ?, monthly_limit = ?, velocity_limit_per_min = ?, allowlist = ?, spending_windows = ?, region_allowlist = ? WHERE id = ?",
      [
        policy.maxPerTx,
        policy.dailyLimit,
        policy.monthlyLimit,
        policy.velocityLimitPerMin,
        JSON.stringify(policy.allowlist),
        policy.spendingWindows ? JSON.stringify(policy.spendingWindows) : null,
        policy.regionAllowlist ? JSON.stringify(policy.regionAllowlist) : null,
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
      const rail = getRail(wallet.preferredRail);
      const result = await rail.execute({
        txId: tx.id,
        walletId: tx.walletId,
        to: tx.to,
        amount: tx.amount,
        amountUnits: unitsFromFloat(tx.amount, 2).toString(),
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
          details: `Rail ${rail.id} rejected settlement of ${tx.amount} to ${tx.to}: ${result.detail ?? "unknown"}`,
        });
        continue;
      }
      await debitWallet(tx.walletId, tx.amount);
      const next = await transitionTransaction(tx.id, "SETTLED", {
        settledAt: now,
        externalRef: result.externalRef,
        rail: rail.id,
      });
      if (next) {
        settled.push(next);
        await recordUsage({
          walletId: tx.walletId,
          orgId: wallet.orgId,
          txId: tx.id,
          amount: tx.amount,
          rail: rail.id,
          fee: computeFee(rail.id, tx.amount),
        });
        await recordCounterpartyPayment(tx.to, tx.amount);
        await addAudit({
          walletId: tx.walletId,
          actor: "system",
          action: "TX_SETTLED",
          details: `${tx.amount} settled to ${tx.to} via rail ${rail.id} (${result.externalRef ?? "local"})${result.feeUnits && result.feeUnits !== "0" ? ` fee=${result.feeUnits}` : ""}`,
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
  now = Date.now(),
): { threshold: number; windowMs: number; anomalies: number; tripped: boolean } {
  const s = getStore();
  const windowMs = BREAKER_WINDOW_MS;
  const cutoff = now - windowMs;
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

/**
 * C6: releases wallets that the circuit breaker froze once their anomaly
 * window has fully elapsed (anomalies === 0). Owner kill-switch freezes are
 * never auto-released — they carry a WALLET_FROZEN audit, not AUTO_FREEZE.
 * Returns the released wallet ids.
 */
export async function releaseExpiredBreakerFreezes(now = Date.now()): Promise<string[]> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute("SELECT id FROM wallets WHERE status = 'FROZEN'");
  const released: string[] = [];
  for (const row of rows) {
    const id = row.id as string;
    const state = getBreakerState(id, now);
    if (state.anomalies > 0) continue;
    const { rows: trips } = await s.client.execute(
      "SELECT 1 FROM audit WHERE wallet_id = ? AND action = 'AUTO_FREEZE' LIMIT 1",
      [id],
    );
    if (trips.length === 0) continue;
    await setWalletStatus(id, "ACTIVE");
    released.push(id);
    await addAudit({
      walletId: id,
      actor: "system",
      action: "BREAKER_RESET",
      details: "Anomaly window elapsed; circuit breaker reset and wallet re-enabled",
    });
    await recordOutbox(id, "BREAKER_RESET", { details: "Circuit breaker reset by scheduler" });
  }
  return released;
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
  input: Omit<Transaction, "id"> & { idempotencyKey?: string },
): Promise<Transaction> {
  const s = getStore();
  await s.ready;
  if (input.idempotencyKey) {
    const existing = await findTransactionByIdempotencyKey(input.idempotencyKey);
    if (existing) return existing;
  }
  const id = randomUUID();
  await appendLedgerRow(
    s.client,
    "transactions",
    ["id", "wallet_id", "from", "to", "amount", "amount_units", "purpose", "status", "rejection_reason", "requested_at", "pending_until", "settled_at", "blocked_at", "revoked_at", "nonce", "step_up_score", "external_ref", "idempotency_key"],
    [
      id,
      input.walletId,
      input.from,
      input.to,
      input.amount,
      unitsFromFloat(input.amount, 2).toString(),
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
      input.idempotencyKey ?? null,
    ],
    txContent({
      walletId: input.walletId,
      from: input.from,
      to: input.to,
      amountUnits: unitsFromFloat(input.amount, 2).toString(),
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
  fields: { rejectionReason?: RejectionReason; settledAt?: number; blockedAt?: number; revokedAt?: number; pendingUntil?: number; externalRef?: string; rail?: string } = {},
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
    rail: fields.rail ?? tx.rail,
  };

  await s.client.execute(
    `UPDATE transactions SET status = ?, rejection_reason = ?, settled_at = ?, blocked_at = ?, revoked_at = ?, pending_until = ?, external_ref = ?, rail = ? WHERE id = ?`,
    [
      next.status,
      next.rejectionReason ?? null,
      next.settledAt ?? null,
      next.blockedAt ?? null,
      next.revokedAt ?? null,
      next.pendingUntil ?? null,
      next.externalRef ?? null,
      next.rail ?? null,
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

export async function creditWallet(id: string, amount: number): Promise<Wallet | null> {
  const s = getStore();
  await s.ready;
  await s.client.execute(
    "UPDATE wallets SET balance = balance + ? WHERE id = ?",
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

function rowToAgentKey(row: Record<string, unknown>): AgentKeyRecord {
  return {
    walletId: row.wallet_id as string,
    publicKey: row.public_key as string,
    label: row.label as string,
    createdAt: Number(row.created_at),
    expiresAt: row.expires_at ? Number(row.expires_at) : undefined,
    revokedAt: row.revoked_at ? Number(row.revoked_at) : undefined,
    lastUsedAt: row.last_used_at ? Number(row.last_used_at) : undefined,
    acl: row.acl ? (JSON.parse(row.acl as string) as AgentKeyRecord["acl"]) : undefined,
  };
}

export async function registerAgentKey(
  walletId: string,
  publicKey: string,
  label: string,
  opts?: { expiresAt?: number; acl?: AgentKeyRecord["acl"] },
): Promise<AgentKeyRecord> {
  const s = getStore();
  await s.ready;
  const record: AgentKeyRecord = {
    walletId,
    publicKey,
    label,
    createdAt: Date.now(),
    expiresAt: opts?.expiresAt,
    acl: opts?.acl,
  };
  await s.client.execute(
    "INSERT INTO agent_keys (wallet_id, public_key, label, created_at, expires_at, acl) VALUES (?, ?, ?, ?, ?, ?)",
    [walletId, publicKey, label, record.createdAt, record.expiresAt ?? null, record.acl ? JSON.stringify(record.acl) : null],
  );
  return record;
}

/** Marks a key's last-used timestamp (called on every signed request). */
export async function touchAgentKey(walletId: string, publicKey: string): Promise<void> {
  const s = getStore();
  await s.ready;
  await s.client.execute(
    "UPDATE agent_keys SET last_used_at = ? WHERE wallet_id = ? AND public_key = ?",
    [Date.now(), walletId, publicKey],
  );
}

export async function getActiveAgentKey(
  walletId: string,
  publicKey: string,
  now = Date.now(),
): Promise<AgentKeyRecord | null> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute(
    "SELECT * FROM agent_keys WHERE wallet_id = ? AND public_key = ? AND revoked_at IS NULL",
    [walletId, publicKey],
  );
  const row = rows[0];
  if (!row) return null;
  const key = rowToAgentKey(row as Record<string, unknown>);
  if (key.expiresAt && now > key.expiresAt) return null;
  return key;
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
  return rows.map((r) => rowToAgentKey(r as Record<string, unknown>));
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

export async function rotateAgentKey(
  walletId: string,
  oldPublicKey: string,
  newPublicKey: string,
  label: string,
  opts?: { expiresAt?: number; acl?: AgentKeyRecord["acl"] },
): Promise<AgentKeyRecord> {
  const s = getStore();
  await s.ready;
  await revokeAgentKey(walletId, oldPublicKey);
  return registerAgentKey(walletId, newPublicKey, label, opts);
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

// ────────────────────────────────────────────────────────────────────────────
// Request audit (B4)
// ────────────────────────────────────────────────────────────────────────────

export interface RequestAuditEntry {
  id: string;
  ts: number;
  method: string;
  path: string;
  keyHash?: string;
  scope?: string;
  walletId?: string;
  ip?: string;
  userAgent?: string;
  result: string;
}

export async function recordRequestAudit(input: {
  method: string;
  path: string;
  keyHash?: string;
  scope?: string;
  walletId?: string;
  ip?: string;
  userAgent?: string;
  result: string;
}): Promise<void> {
  const s = getStore();
  await s.ready;
  await s.client.execute(
    "INSERT INTO request_audit (id, ts, method, path, key_hash, scope, wallet_id, ip, user_agent, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      randomUUID(),
      Date.now(),
      input.method,
      input.path,
      input.keyHash ?? null,
      input.scope ?? null,
      input.walletId ?? null,
      input.ip ?? null,
      input.userAgent ? String(input.userAgent).slice(0, 256) : null,
      input.result,
    ],
  );
}

export async function listRequestAudit(limit = 200): Promise<RequestAuditEntry[]> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute(
    "SELECT * FROM request_audit ORDER BY ts DESC LIMIT ?",
    [limit],
  );
  return rows.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      id: row.id as string,
      ts: Number(row.ts),
      method: row.method as string,
      path: row.path as string,
      keyHash: row.key_hash ? (row.key_hash as string) : undefined,
      scope: row.scope ? (row.scope as string) : undefined,
      walletId: row.wallet_id ? (row.wallet_id as string) : undefined,
      ip: row.ip ? (row.ip as string) : undefined,
      userAgent: row.user_agent ? (row.user_agent as string) : undefined,
      result: row.result as string,
    };
  });
}

export async function resetRequestAudit(): Promise<void> {
  const s = getStore();
  await s.ready;
  await s.client.execute("DELETE FROM request_audit");
}

// ────────────────────────────────────────────────────────────────────────────
// Auth sessions (1.1)
// ────────────────────────────────────────────────────────────────────────────

export interface AuthSession {
  id: string;
  email: string;
  createdAt: number;
  lastUsedAt: number;
  ip?: string;
  userAgent?: string;
  revokedAt?: number;
}

export async function createSession(input: {
  email: string;
  ip?: string;
  userAgent?: string;
}): Promise<AuthSession> {
  const s = getStore();
  await s.ready;
  const now = Date.now();
  const session: AuthSession = {
    id: randomUUID(),
    email: input.email.toLowerCase(),
    createdAt: now,
    lastUsedAt: now,
    ip: input.ip,
    userAgent: input.userAgent,
  };
  await s.client.execute(
    "INSERT INTO sessions (id, email, created_at, last_used_at, ip, user_agent, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)",
    [session.id, session.email, session.createdAt, session.lastUsedAt, session.ip ?? null, session.userAgent ?? null],
  );
  return session;
}

export async function getSession(id: string): Promise<AuthSession | null> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute("SELECT * FROM sessions WHERE id = ?", [id]);
  if (rows.length === 0) return null;
  return rowToSession(rows[0] as Record<string, unknown>);
}

export async function touchSession(id: string): Promise<void> {
  const s = getStore();
  await s.ready;
  await s.client.execute("UPDATE sessions SET last_used_at = ? WHERE id = ?", [Date.now(), id]);
}

export async function listSessions(email?: string): Promise<AuthSession[]> {
  const s = getStore();
  await s.ready;
  const { rows } = email
    ? await s.client.execute("SELECT * FROM sessions WHERE email = ? ORDER BY last_used_at DESC", [email])
    : await s.client.execute("SELECT * FROM sessions ORDER BY last_used_at DESC");
  return rows.map((r) => rowToSession(r as Record<string, unknown>));
}

export async function revokeSession(id: string): Promise<boolean> {
  const s = getStore();
  await s.ready;
  const existing = await getSession(id);
  if (!existing) return false;
  await s.client.execute("UPDATE sessions SET revoked_at = ? WHERE id = ?", [Date.now(), id]);
  return true;
}

export async function revokeApiKeyByHash(keyHash: string, scope?: string): Promise<void> {
  const s = getStore();
  await s.ready;
  await s.client.execute(
    "INSERT INTO revoked_keys (key_hash, scope, revoked_at) VALUES (?, ?, ?) ON CONFLICT (key_hash) DO NOTHING",
    [keyHash, scope ?? null, Date.now()],
  );
}

export async function isApiKeyRevoked(keyHash: string): Promise<boolean> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute(
    "SELECT 1 FROM revoked_keys WHERE key_hash = ?",
    [keyHash],
  );
  return rows.length > 0;
}

export async function consumeMagicToken(jti: string, email: string): Promise<boolean> {
  const s = getStore();
  await s.ready;
  try {
    await s.client.execute(
      "INSERT INTO magic_tokens (jti, email, used_at) VALUES (?, ?, ?)",
      [jti, email, Date.now()],
    );
    return true;
  } catch {
    return false;
  }
}


function rowToSession(r: Record<string, unknown>): AuthSession {
  return {
    id: r.id as string,
    email: r.email as string,
    createdAt: Number(r.created_at),
    lastUsedAt: Number(r.last_used_at),
    ip: r.ip ? (r.ip as string) : undefined,
    userAgent: r.user_agent ? (r.user_agent as string) : undefined,
    revokedAt: r.revoked_at ? Number(r.revoked_at) : undefined,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Reconciliation reports (A5)
// ────────────────────────────────────────────────────────────────────────────

export async function saveReconciliationReport(report: {
  id: string;
  runAt: number;
  total: number;
  matched: number;
  breaks: number;
  breaksList: unknown[];
}): Promise<void> {
  const s = getStore();
  await s.ready;
  await s.client.execute(
    "INSERT INTO reconciliation_reports (id, run_at, total, matched, breaks, details) VALUES (?, ?, ?, ?, ?, ?)",
    [report.id, report.runAt, report.total, report.matched, report.breaks, JSON.stringify(report.breaksList)],
  );
}

export async function latestReconciliationReport(): Promise<{
  id: string;
  runAt: number;
  total: number;
  matched: number;
  breaks: number;
  breaksList: unknown[];
} | null> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute(
    "SELECT * FROM reconciliation_reports ORDER BY run_at DESC LIMIT 1",
  );
  if (rows.length === 0) return null;
  const row = rows[0] as Record<string, unknown>;
  return {
    id: row.id as string,
    runAt: Number(row.run_at),
    total: Number(row.total),
    matched: Number(row.matched),
    breaks: Number(row.breaks),
    breaksList: JSON.parse(row.details as string) as unknown[],
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Global + per-org kill switches (C7). A super-admin can freeze an org's whole
// fleet with a single call; the global switch freezes everything. Both are
// checked at transaction creation so agents can never bypass them.
// ────────────────────────────────────────────────────────────────────────────

export interface KillSwitchState {
  enabled: boolean;
  reason: string;
  setAt: number;
}

export async function setOrgKillSwitch(
  orgId: string,
  reason: string,
  enabled: boolean,
): Promise<KillSwitchState> {
  const s = getStore();
  await s.ready;
  const state: KillSwitchState = { enabled, reason, setAt: Date.now() };
  await s.client.execute(
    `INSERT INTO kill_switches (org_id, reason, enabled, set_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (org_id) DO UPDATE SET reason = excluded.reason, enabled = excluded.enabled, set_at = excluded.set_at`,
    [orgId, reason, enabled ? 1 : 0, state.setAt],
  );
  if (enabled) {
    await addAudit({
      walletId: "*",
      actor: "owner",
      action: "ORG_KILL_SWITCH_ON",
      details: JSON.stringify({ orgId, reason }),
    });
  }
  return state;
}

export async function getOrgKillSwitch(
  orgId: string,
): Promise<KillSwitchState | null> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute(
    "SELECT * FROM kill_switches WHERE org_id = ?",
    [orgId],
  );
  if (rows.length === 0) return null;
  const r = rows[0] as Record<string, unknown>;
  return {
    enabled: Boolean(r.enabled),
    reason: r.reason as string,
    setAt: Number(r.set_at),
  };
}

/** Master kill switch scope sentinel stored under the "*" org id. */
const GLOBAL_KILL_ORG = "*";

export async function setGlobalKillSwitch(
  reason: string,
  enabled: boolean,
): Promise<KillSwitchState> {
  return setOrgKillSwitch(GLOBAL_KILL_ORG, reason, enabled);
}

export async function getGlobalKillSwitch(): Promise<KillSwitchState | null> {
  return getOrgKillSwitch(GLOBAL_KILL_ORG);
}

/**
 * True if the org (or everything) is frozen by a kill switch. The global
 * switch overrides any org-local state — it is the last line of defense.
 */
export async function isOrgFrozen(orgId?: string): Promise<string | null> {
  const global = await getGlobalKillSwitch();
  if (global?.enabled) return global.reason;
  if (orgId) {
    const local = await getOrgKillSwitch(orgId);
    if (local?.enabled) return local.reason;
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Insurance / guarantee pool (D6): a configurable loss-sharing cap per wallet.
// The pool covers the first `lossCap` of any settled loss attributed to a
// covered wallet, so counterparties have a real backstop for agent defaults.
// ────────────────────────────────────────────────────────────────────────────

export interface InsurancePool {
  id: string;
  orgId?: string;
  name: string;
  capacity: number;
  lossCap: number;
  deployed: number;
  createdAt: number;
}

export async function createPool(input: {
  name: string;
  orgId?: string;
  capacity: number;
  lossCap: number;
}): Promise<InsurancePool> {
  const s = getStore();
  await s.ready;
  const pool: InsurancePool = {
    id: randomUUID(),
    orgId: input.orgId,
    name: input.name,
    capacity: input.capacity,
    lossCap: input.lossCap,
    deployed: 0,
    createdAt: Date.now(),
  };
  await s.client.execute(
    `INSERT INTO insurance_pools (id, org_id, name, capacity, loss_cap, deployed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [pool.id, pool.orgId ?? null, pool.name, pool.capacity, pool.lossCap, pool.deployed, pool.createdAt],
  );
  return pool;
}

export async function listPools(orgId?: string): Promise<InsurancePool[]> {
  const s = getStore();
  await s.ready;
  const { rows } = orgId
    ? await s.client.execute("SELECT * FROM insurance_pools WHERE org_id = ? ORDER BY created_at DESC", [orgId])
    : await s.client.execute("SELECT * FROM insurance_pools ORDER BY created_at DESC");
  return rows.map((r) => rowToPool(r as Record<string, unknown>));
}

export async function getPool(id: string): Promise<InsurancePool | null> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute("SELECT * FROM insurance_pools WHERE id = ?", [id]);
  return rows.length > 0 ? rowToPool(rows[0] as Record<string, unknown>) : null;
}

/**
 * Remaining coverage for a pool — capacity minus what is already deployed.
 * Losses beyond this are not covered (the pool cannot over-commit).
 */
export function poolRemaining(pool: InsurancePool): number {
  return Math.max(0, pool.capacity - pool.deployed);
}

export async function deployPoolCoverage(poolId: string, amount: number): Promise<InsurancePool | null> {
  const s = getStore();
  await s.ready;
  const pool = await getPool(poolId);
  if (!pool) return null;
  if (amount <= 0 || poolRemaining(pool) < amount) return null;
  await s.client.execute(
    "UPDATE insurance_pools SET deployed = deployed + ? WHERE id = ?",
    [amount, poolId],
  );
  return getPool(poolId);
}

function rowToPool(r: Record<string, unknown>): InsurancePool {
  return {
    id: r.id as string,
    orgId: r.org_id ? (r.org_id as string) : undefined,
    name: r.name as string,
    capacity: Number(r.capacity),
    lossCap: Number(r.loss_cap),
    deployed: Number(r.deployed),
    createdAt: Number(r.created_at),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Per-user settings (E6): display currency + timezone. UTC everywhere in the
// ledger; these only change how numbers and timestamps are rendered.
// ────────────────────────────────────────────────────────────────────────────

export interface UserSettings {
  owner: string;
  currency: string;
  timezone: string;
  updatedAt: number;
}

export async function getUserSettings(owner: string): Promise<UserSettings> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute(
    "SELECT * FROM user_settings WHERE owner = ?",
    [owner.toLowerCase()],
  );
  if (rows.length === 0) {
    return { owner: owner.toLowerCase(), currency: "USD", timezone: "UTC", updatedAt: 0 };
  }
  const r = rows[0] as Record<string, unknown>;
  return {
    owner: r.owner as string,
    currency: r.currency as string,
    timezone: r.timezone as string,
    updatedAt: Number(r.updated_at),
  };
}

export async function setUserSettings(
  owner: string,
  patch: Partial<Pick<UserSettings, "currency" | "timezone">>,
): Promise<UserSettings> {
  const s = getStore();
  await s.ready;
  const current = await getUserSettings(owner);
  const next: UserSettings = {
    ...current,
    currency: patch.currency ?? current.currency,
    timezone: patch.timezone ?? current.timezone,
    updatedAt: Date.now(),
  };
  await s.client.execute(
    `INSERT INTO user_settings (owner, currency, timezone, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (owner) DO UPDATE SET currency = excluded.currency, timezone = excluded.timezone, updated_at = excluded.updated_at`,
    [next.owner, next.currency, next.timezone, next.updatedAt],
  );
  return next;
}

// ────────────────────────────────────────────────────────────────────────────
// DID registry (D2): persisted DID documents. Resolution + verification live
// in the pure `src/core/did.ts` module; this is the durable backing store.
// ────────────────────────────────────────────────────────────────────────────

export async function registerDidDoc(did: string, doc: unknown): Promise<void> {
  const s = getStore();
  await s.ready;
  const now = Date.now();
  await s.client.execute(
    `INSERT INTO did_registry (did, doc, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (did) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at`,
    [did, JSON.stringify(doc), now, now],
  );
}

export async function getDidDoc(did: string): Promise<unknown | null> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute("SELECT * FROM did_registry WHERE did = ?", [did]);
  if (rows.length === 0) return null;
  return JSON.parse((rows[0] as Record<string, unknown>).doc as string) as unknown;
}

export async function listDidDocs(): Promise<string[]> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute("SELECT did FROM did_registry ORDER BY created_at");
  return rows.map((r) => r.did as string);
}

// ────────────────────────────────────────────────────────────────────────────
// Scheduled report log (E2): tracks daily/monthly digests + SAR-lite exports
// delivered to email/Slack so the ops story is auditable.
// ────────────────────────────────────────────────────────────────────────────

export interface ReportRecord {
  id: string;
  kind: string;
  channel: string;
  summary: string;
  createdAt: number;
}

export async function recordReport(input: {
  kind: string;
  channel: string;
  summary: string;
}): Promise<ReportRecord> {
  const s = getStore();
  await s.ready;
  const record: ReportRecord = { id: randomUUID(), ...input, createdAt: Date.now() };
  await s.client.execute(
    "INSERT INTO report_log (id, kind, channel, summary, created_at) VALUES (?, ?, ?, ?, ?)",
    [record.id, record.kind, record.channel, record.summary, record.createdAt],
  );
  return record;
}

export async function listReports(kind?: string): Promise<ReportRecord[]> {
  const s = getStore();
  await s.ready;
  const { rows } = kind
    ? await s.client.execute("SELECT * FROM report_log WHERE kind = ? ORDER BY created_at DESC LIMIT 50", [kind])
    : await s.client.execute("SELECT * FROM report_log ORDER BY created_at DESC LIMIT 50");
  return rows.map((r) => ({
    id: r.id as string,
    kind: r.kind as string,
    channel: r.channel as string,
    summary: r.summary as string,
    createdAt: Number(r.created_at),
  }));
}

// ────────────────────────────────────────────────────────────────────────────
// Health / readiness (C5): a cheap round-trip the /api/health route uses.
// ────────────────────────────────────────────────────────────────────────────

export async function dbPing(): Promise<boolean> {
  try {
    const s = getStore();
    await s.ready;
    await s.client.execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Agent reputation (D5): derived from the wallet's settle/block history. The
// guard consumes it as a soft signal (documented in /api/analytics), and it
// feeds the insurance pool's pricing story. Higher = safer.
// ────────────────────────────────────────────────────────────────────────────

export interface AgentReputation {
  walletId: string;
  score: number;
  settled: number;
  blocked: number;
  revoked: number;
  totalSpent: number;
  lastActiveAt?: number;
}

/** Operator reputation resets: walletId → timestamp. History before the reset is ignored when scoring (P1-2 deadlock fix). */
const reputationResets = new Map<string, number>();

export function resetWalletReputation(walletId: string): void {
  reputationResets.set(walletId, Date.now());
}

export async function agentReputation(walletId: string): Promise<AgentReputation> {
  const s = getStore();
  await s.ready;
  const resetAt = reputationResets.get(walletId) ?? 0;
  const { rows } = await s.client.execute(
    "SELECT status, amount, rejection_reason, requested_at, blocked_at FROM transactions WHERE wallet_id = ?",
    [walletId],
  );
  let settled = 0;
  let blocked = 0;
  let revoked = 0;
  let totalSpent = 0;
  let lastActiveAt: number | undefined;
  for (const r of rows) {
    // An operator reputation reset ignores all pre-reset history, so a stuck
    // wallet can re-earn trust instead of being permanently deadlocked.
    // `<=` (not `<`) so rows stamped in the same ms as the reset are excluded.
    const occurredAt = Number(r.blocked_at ?? r.requested_at ?? 0);
    if (occurredAt > 0 && occurredAt <= resetAt) continue;
    const status = r.status as string;
    const amount = Number(r.amount);
    if (status === "SETTLED") {
      settled += 1;
      totalSpent += amount;
      lastActiveAt = Math.max(lastActiveAt ?? 0, Number(r.requested_at ?? 0));
    } else if (status === "BLOCKED") {
      // Operator-induced blocks (kill-switch freezes) are not the agent's
      // fault — they must not drag the score down, or a legitimately frozen
      // agent stays reputation-blocked after the freeze is lifted.
      const reason = r.rejection_reason as string | undefined;
      if (reason === "WALLET_FROZEN" || reason === "ORGANIZATION_FROZEN") continue;
      // A reputation block must never deepen the penalty that caused it.
      // Otherwise a blocked agent can never raise its own score and is
      // deadlocked forever (finding P1-2).
      if (reason === "REPUTATION_BLOCKED") continue;
      blocked += 1;
    } else if (status === "REVOKED") {
      revoked += 1;
    }
  }
  const attempt = settled + blocked + revoked;
  const reliability = attempt > 0 ? settled / attempt : 0;
  const penalty = Math.min(1, blocked / Math.max(1, attempt));
  const spendFactor = Math.min(1, totalSpent / 100000);
  const score = Math.round(
    Math.max(0, Math.min(100, 20 + 60 * reliability - 30 * penalty + 20 * spendFactor)),
  );
  return {
    walletId,
    score,
    settled,
    blocked,
    revoked,
    totalSpent,
    lastActiveAt,
  };
}
