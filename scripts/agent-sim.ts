#!/usr/bin/env node
/**
 * AEGIS — standalone autonomous-agent simulator.
 *
 * Built on the AEGIS SDK (src/lib/sdk.ts) — the exact surface a real agent
 * integrates with. The agent holds ONLY its credentials and can call exactly
 * one thing: `transfer()`. The guard decides what happens — not this script.
 *
 * Two auth modes:
 *  1. Ed25519 SIGNED (preferred) — the agent IS its keypair.
 *     Provide the private key minted from POST /api/keys/mint.
 *  2. Legacy scoped agent JWT (migration mode).
 *
 * Usage (signed):
 *   AGENT_PRIVATE_KEY=<pkcs8-b64url> AGENT_WALLET=<id> npm run sim
 *   AGENT_BASE_URL=http://localhost:3000 (optional)
 */
import { Aegis } from "../src/lib/sdk";

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

const agent = new Aegis(
  PRIVATE_KEY
    ? { baseUrl: BASE, walletId: WALLET, privateKey: PRIVATE_KEY }
    : { baseUrl: BASE, apiKey: LEGACY_KEY },
);

const plan = [
  { to: "compute:0xCAFE0001", amount: 30, purpose: "GPU burst" },
  { to: "compute:0xCAFE0001", amount: 250, purpose: "attempt: exceed per-tx cap" },
  { to: "drain:0xBADBEEF", amount: 20, purpose: "attempt: unapproved payee" },
  { to: "api:0xBEEF0002", amount: 990, purpose: "attempt: exhaust daily budget" },
  { to: "storage:0xDEAD0003", amount: 100000, purpose: "attempt: drain wallet" },
  { to: "compute:0xCAFE0001", amount: 45, purpose: "GPU burst (valid)" },
];

console.log(
  `\n  AEGIS AGENT SIM (SDK) — wallet ${WALLET} [${
    PRIVATE_KEY ? "Ed25519 signed" : "legacy JWT"
  }]\n`,
);
void (async () => {
  for (const step of plan) {
    const r = await agent.transfer(step);
    const state = (r.body.status2 as string) ?? (r.body.status as string) ?? (r.body.error as string);
    console.log(
      `  ${step.amount.toString().padStart(6)} → ${step.to.padEnd(18)} ` +
        `${state.padEnd(10)} [HTTP ${r.status}] ${r.body.details ?? r.body.reason ?? ""}`,
    );
  }
  console.log("\n  Done. The guard allowed only what the policy allowed.\n");
})();
