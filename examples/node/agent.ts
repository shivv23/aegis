#!/usr/bin/env node
/**
 * AEGIS — runnable Node/TS sample agent.
 *
 * Bootstraps the SDK with AEGIS_BASE_URL + AEGIS_OWNER_KEY (grab the master
 * owner key from GET /api/bootstrap), provisions a wallet, mints an Ed25519
 * agent keypair, then signs two transfers: one inside policy (PENDING) and
 * one that exceeds the per-tx cap (BLOCKED by the guard). The guard decides —
 * not the agent.
 *
 * Run:  AEGIS_BASE_URL=http://localhost:3000 AEGIS_OWNER_KEY=<key> \
 *         npx tsx examples/node/agent.ts
 */
import { Aegis } from "../../src/lib/sdk";
import type { AegisResponse } from "../../src/lib/sdk";

const BASE = process.env.AEGIS_BASE_URL ?? "http://localhost:3000";
const OWNER_KEY = process.env.AEGIS_OWNER_KEY;

if (!OWNER_KEY) {
  console.error("Missing AEGIS_OWNER_KEY. Fetch it from GET /api/bootstrap.");
  process.exit(1);
}

function show(label: string, r: AegisResponse) {
  const body = r.body as Record<string, unknown>;
  const tx = body.transaction as Record<string, unknown> | undefined;
  const detail = [body.status, body.error, body.reason && `reason=${body.reason}`, tx?.id && `tx=${tx.id}`]
    .filter(Boolean)
    .join("  ");
  console.log(`  ${label.padEnd(14)} [HTTP ${r.status}] ${detail}`);
}

async function main() {
  const owner = new Aegis({ baseUrl: BASE, apiKey: OWNER_KEY });

  const provisioned = await owner.createWallet({
    name: "sample-agent-wallet",
    ownerDid: "did:org:acme",
    balance: 500,
    policy: {
      maxPerTx: 100,
      dailyLimit: 1000,
      monthlyLimit: 5000,
      velocityLimitPerMin: 30,
      allowlist: ["compute:0xCAFE0001", "api:0xBEEF0002"],
    },
  });
  const wallet = provisioned.body.wallet as { id: string };
  console.log(`\n  wallet ${wallet.id} provisioned [HTTP ${provisioned.status}] (balance 500, maxPerTx 100)`);

  const minted = await owner.mintAgentKey(wallet.id, "sample-agent");
  const agent = new Aegis({
    baseUrl: BASE,
    walletId: wallet.id,
    privateKey: (minted.body as { privateKey: string }).privateKey,
  });
  console.log("  agent Ed25519 key minted — the agent IS its keypair\n");

  show("within policy", await agent.transfer({ to: "compute:0xCAFE0001", amount: 30, purpose: "GPU burst" }));
  show("over cap", await agent.transfer({ to: "compute:0xCAFE0001", amount: 250, purpose: "attempt: exceed per-tx cap" }));

  console.log("\n  Done. The guard allowed only what the policy allowed.\n");
}

void main().catch((e) => {
  console.error(`\n  failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
