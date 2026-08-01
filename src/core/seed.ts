import type { Client } from "@libsql/client";
import { randomUUID } from "node:crypto";
import type { Transaction, WalletPolicy } from "./types";

export const SEED_WALLET_ID = "wallet-tradingbot-42";

export const SEED_VENDORS = [
  "compute:0xCAFE0001",
  "api:0xBEEF0002",
  "storage:0xDEAD0003",
];

export async function seed(client: Client): Promise<void> {
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
    await client.execute(
      `INSERT INTO transactions (id, wallet_id, "from", "to", amount, purpose, status, rejection_reason, requested_at, pending_until, settled_at, blocked_at, revoked_at, nonce)
       VALUES (?, ?, ?, ?, ?, ?, 'SETTLED', NULL, ?, ?, ?, NULL, NULL, ?)`,
      [
        randomUUID(),
        SEED_WALLET_ID,
        SEED_WALLET_ID,
        h.to,
        h.amount,
        h.purpose,
        settledAt,
        settledAt,
        settledAt,
        randomUUID(),
      ],
    );
  }

  await client.execute(
    `INSERT INTO audit (id, wallet_id, actor, action, details, timestamp) VALUES (?, ?, ?, ?, ?, ?)`,
    [randomUUID(), SEED_WALLET_ID, "system", "WALLET_CREATED", "Wallet provisioned for TradingBot-42", now - 30 * dayMs],
  );
  await client.execute(
    `INSERT INTO audit (id, wallet_id, actor, action, details, timestamp) VALUES (?, ?, ?, ?, ?, ?)`,
    [randomUUID(), SEED_WALLET_ID, "system", "POLICY_SET", "maxPerTx=$100 dailyLimit=$1000 monthlyLimit=$5000 velocity=30/min", now - 30 * dayMs],
  );
}

export type { Transaction };
