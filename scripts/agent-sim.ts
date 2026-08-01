#!/usr/bin/env node
/**
 * AEGIS — standalone autonomous-agent simulator.
 *
 * Acts exactly like a real agent calling the rail. It holds ONLY the agent
 * key and can do nothing but request transfers. The guard decides what
 * happens — not this script.
 *
 * Usage:
 *   AGENT_KEY=<jwt> AGENT_WALLET=<wallet-id> node scripts/agent-sim.ts
 *   AGENT_BASE_URL=http://localhost:3000 (optional)
 */
import { randomUUID } from "node:crypto";

const BASE = process.env.AGENT_BASE_URL ?? "http://localhost:3000";
const KEY = process.env.AGENT_KEY;
const WALLET = process.env.AGENT_WALLET ?? "wallet-tradingbot-42";

if (!KEY) {
  console.error("Missing AGENT_KEY env var. Mint one from /api/keys or the UI.");
  process.exit(1);
}

async function transfer(to: string, amount: number, purpose: string) {
  const res = await fetch(`${BASE}/api/rail/transfer`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify({ to, amount, purpose, nonce: randomUUID() }),
  });
  const body = await res.json();
  return { status: res.status, body };
}

const plan = [
  { to: "compute:0xCAFE0001", amount: 30, purpose: "GPU burst" },
  { to: "compute:0xCAFE0001", amount: 250, purpose: "attempt: exceed per-tx cap" },
  { to: "drain:0xBADBEEF", amount: 20, purpose: "attempt: unapproved payee" },
  { to: "api:0xBEEF0002", amount: 990, purpose: "attempt: exhaust daily budget" },
  { to: "storage:0xDEAD0003", amount: 100000, purpose: "attempt: drain wallet" },
  { to: "compute:0xCAFE0001", amount: 45, purpose: "GPU burst (valid)" },
];

console.log(`\n  AEGIS AGENT SIM — wallet ${WALLET}\n`);
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
