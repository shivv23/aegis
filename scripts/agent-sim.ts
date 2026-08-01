#!/usr/bin/env node
/**
 * AEGIS — standalone autonomous-agent simulator.
 *
 * Acts exactly like a real agent calling the rail. Supports two auth modes:
 *  1. Ed25519 SIGNED requests (preferred) — the agent IS its keypair.
 *     Provide the private key minted from POST /api/keys/mint.
 *  2. Legacy scoped agent JWT (migration mode).
 *
 * The agent holds ONLY its key and can do nothing but request transfers.
 * The guard decides what happens — not this script.
 *
 * Usage (signed):
 *   AGENT_PRIVATE_KEY=<pkcs8-b64url> AGENT_WALLET=<id> node scripts/agent-sim.ts
 *   AGENT_BASE_URL=http://localhost:3000 (optional)
 *
 * Usage (legacy JWT):
 *   AGENT_KEY=<jwt> AGENT_WALLET=<id> node scripts/agent-sim.ts
 */
import { createPrivateKey, randomUUID, sign } from "node:crypto";

const BASE = process.env.AGENT_BASE_URL ?? "http://localhost:3000";
const WALLET = process.env.AGENT_WALLET ?? "wallet-tradingbot-42";
const PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY;
const LEGACY_KEY = process.env.AGENT_KEY;

if (!PRIVATE_KEY && !LEGACY_KEY) {
  console.error(
    "Missing credentials. Mint an agent keypair from POST /api/keys/mint " +
      "and set AGENT_PRIVATE_KEY, or pass a legacy AGENT_KEY JWT.",
  );
  process.exit(1);
}

function canonicalMessage(req: {
  walletId: string;
  nonce: string;
  requestedAt: number;
  to: string;
  amount: number;
  purpose: string;
}): string {
  return [
    "aegis-agent-transfer",
    "v1",
    req.walletId,
    req.nonce,
    req.requestedAt,
    req.to,
    req.amount,
    req.purpose,
  ].join("|");
}

async function transfer(to: string, amount: number, purpose: string) {
  const nonce = randomUUID();
  const requestedAt = Date.now();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const body = { to, amount, purpose, nonce };

  if (PRIVATE_KEY) {
    const key = createPrivateKey({
      key: Buffer.from(PRIVATE_KEY, "base64url"),
      type: "pkcs8",
      format: "der",
    });
    const message = canonicalMessage({
      walletId: WALLET,
      nonce,
      requestedAt,
      to,
      amount,
      purpose,
    });
    headers["x-aegis-wallet"] = WALLET;
    headers["x-aegis-timestamp"] = String(requestedAt);
    headers["x-aegis-signature"] = sign(null, Buffer.from(message), key).toString(
      "base64url",
    );
  } else {
    headers["Authorization"] = `Bearer ${LEGACY_KEY}`;
  }

  const res = await fetch(`${BASE}/api/rail/transfer`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

const plan = [
  { to: "compute:0xCAFE0001", amount: 30, purpose: "GPU burst" },
  { to: "compute:0xCAFE0001", amount: 250, purpose: "attempt: exceed per-tx cap" },
  { to: "drain:0xBADBEEF", amount: 20, purpose: "attempt: unapproved payee" },
  { to: "api:0xBEEF0002", amount: 990, purpose: "attempt: exhaust daily budget" },
  { to: "storage:0xDEAD0003", amount: 100000, purpose: "attempt: drain wallet" },
  { to: "compute:0xCAFE0001", amount: 45, purpose: "GPU burst (valid)" },
];

console.log(
  `\n  AEGIS AGENT SIM — wallet ${WALLET} [${
    PRIVATE_KEY ? "Ed25519 signed" : "legacy JWT"
  }]\n`,
);
void (async () => {
  for (const step of plan) {
    const { status, body } = await transfer(step.to, step.amount, step.purpose);
    const state = body.status2 ?? body.status ?? body.error;
    console.log(
      `  ${step.amount.toString().padStart(6)} → ${step.to.padEnd(18)} ` +
        `${state.padEnd(10)} [HTTP ${status}] ${body.details ?? body.reason ?? ""}`,
    );
  }
  console.log("\n  Done. The guard allowed only what the policy allowed.\n");
})();
