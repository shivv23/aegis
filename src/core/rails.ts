import { createHash } from "node:crypto";

/**
 * Payment rail adapter. The guard never changes — only the executor does.
 * Settlement is routed through whichever rail is active so real-money rails
 * (testnet USDC, ACH-lite) can be plugged in without touching enforcement.
 */

export type RailId = "sandbox" | "usdc-testnet" | "ach-lite";

export interface RailSettlementInput {
  txId: string;
  walletId: string;
  to: string;
  amount: number;
  purpose: string;
  nonce: string;
  requestedAt: number;
}

export interface RailResult {
  status: "SETTLED" | "FAILED";
  externalRef?: string;
  detail?: string;
}

export interface Rail {
  id: RailId;
  name: string;
  description: string;
  execute(input: RailSettlementInput): Promise<RailResult>;
}

/** Deterministic fake on-chain ref from the settlement's immutable fields. */
function fakeTxHash(input: RailSettlementInput): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([input.walletId, input.to, input.amount, input.nonce, input.requestedAt]))
    .digest("hex");
  return "0x" + digest.slice(0, 40);
}

const sandboxRail: Rail = {
  id: "sandbox",
  name: "Sandbox (in-process)",
  description: "Settles instantly inside the app. The default demo rail.",
  async execute(input) {
    return { status: "SETTLED", externalRef: `local://${input.txId}` };
  },
};

const usdcTestnetRail: Rail = {
  id: "usdc-testnet",
  name: "USDC testnet (simulated)",
  description:
    "Simulated stablecoin settlement on a testnet. Produces a deterministic on-chain-style reference.",
  async execute(input) {
    // When a real USDC bridge/gateway URL is configured, forward the
    // settlement; otherwise simulate a successful on-chain settlement.
    const url = process.env.AEGIS_USDC_RAIL_URL;
    if (url) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        return { status: "FAILED", detail: `Rail gateway returned ${res.status}` };
      }
      const body = (await res.json()) as { txHash?: string };
      return { status: "SETTLED", externalRef: body.txHash ?? fakeTxHash(input) };
    }
    return { status: "SETTLED", externalRef: fakeTxHash(input) };
  },
};

const achLiteRail: Rail = {
  id: "ach-lite",
  name: "ACH-lite (mock)",
  description: "Mock bank rail. Settles with a bank-style reference.",
  async execute(input) {
    return { status: "SETTLED", externalRef: `ach://${fakeTxHash(input).slice(2, 12)}` };
  },
};

const rails: Record<RailId, Rail> = {
  sandbox: sandboxRail,
  "usdc-testnet": usdcTestnetRail,
  "ach-lite": achLiteRail,
};

export function getRail(id?: string): Rail {
  const key = (id ?? process.env.AEGIS_RAIL ?? "sandbox") as RailId;
  return rails[key] ?? sandboxRail;
}

export function listRails(): Rail[] {
  return Object.values(rails).map(({ id, name, description }) => ({
    id,
    name,
    description,
    execute: undefined as unknown as Rail["execute"],
  }));
}
