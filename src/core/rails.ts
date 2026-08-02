import { createHash } from "node:crypto";

/**
 * Payment rail adapter. The guard never changes — only the executor does.
 * Settlement is routed through whichever rail is active so real-money rails
 * (testnet USDC, ACH-lite) can be plugged in without touching enforcement.
 *
 * Rail selection (A2): wallet.preferredRail → AEGIS_RAIL env → sandbox.
 *
 * Circle USDC testnet: set AEGIS_CIRCLE_API_KEY and optionally
 * AEGIS_CIRCLE_SOURCE_ADDRESS to settle via the Circle sandbox API and return
 * the on-chain transaction hash as the external reference.
 */

export type RailId = "sandbox" | "usdc-testnet" | "ach-lite";

export interface RailSettlementInput {
  txId: string;
  walletId: string;
  to: string;
  amount: number;
  amountUnits: string;
  purpose: string;
  nonce: string;
  requestedAt: number;
}

export interface RailResult {
  status: "SETTLED" | "FAILED";
  externalRef?: string;
  /** Integer fee units charged by the rail, if any (USD display precision). */
  feeUnits?: string;
  detail?: string;
}

export interface Rail {
  id: RailId;
  name: string;
  description: string;
  execute(input: RailSettlementInput): Promise<RailResult>;
}

/** Deterministic fake on-chain ref from the settlement's immutable fields. */
export function deriveExternalRef(input: {
  walletId: string;
  to: string;
  amount: number;
  nonce: string;
  requestedAt: number;
}): string {
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
    return { status: "SETTLED", externalRef: `local://${input.txId}`, feeUnits: "0" };
  },
};

async function circleUsdcSettlement(input: RailSettlementInput): Promise<RailResult> {
  const apiKey = process.env.AEGIS_CIRCLE_API_KEY;
  const sourceAddress = process.env.AEGIS_CIRCLE_SOURCE_ADDRESS;
  if (!apiKey) {
    // No real gateway configured: simulate an on-chain settlement.
    return { status: "SETTLED", externalRef: deriveExternalRef(input), feeUnits: "0" };
  }
  try {
    const body: Record<string, unknown> = {
      idempotencyKey: input.txId,
      source: sourceAddress ? { type: "blockchain", address: sourceAddress } : undefined,
      destination: { type: "blockchain", address: input.to },
      amount: { amount: String(input.amountUnits ?? Math.round(input.amount * 100)), currency: "USD" },
    };
    if (!body.source) delete body.source;
    const res = await fetch("https://api.circle.com/v1/transfers", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return { status: "FAILED", detail: `Circle returned ${res.status}` };
    }
    const data = (await res.json()) as {
      data?: { transactionHash?: string; id?: string };
    };
    const txHash = data.data?.transactionHash ?? data.data?.id;
    if (!txHash) {
      return { status: "FAILED", detail: "Circle did not return a transaction hash" };
    }
    return { status: "SETTLED", externalRef: txHash, feeUnits: "0" };
  } catch (e) {
    return { status: "FAILED", detail: e instanceof Error ? e.message : "Circle request failed" };
  }
}

const usdcTestnetRail: Rail = {
  id: "usdc-testnet",
  name: "USDC testnet",
  description:
    "Circle sandbox settlement when AEGIS_CIRCLE_API_KEY is set; deterministic on-chain-style reference otherwise.",
  async execute(input) {
    return circleUsdcSettlement(input);
  },
};

const achLiteRail: Rail = {
  id: "ach-lite",
  name: "ACH-lite (mock)",
  description: "Mock bank rail. Settles with a bank-style reference.",
  async execute(input) {
    const ref = deriveExternalRef(input).slice(2, 12);
    return { status: "SETTLED", externalRef: `ach://${ref}`, feeUnits: "0" };
  },
};

const rails: Record<RailId, Rail> = {
  sandbox: sandboxRail,
  "usdc-testnet": usdcTestnetRail,
  "ach-lite": achLiteRail,
};

export function getRail(preferredRail?: string): Rail {
  const key = (preferredRail ?? process.env.AEGIS_RAIL ?? "sandbox") as RailId;
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

/** True when a rail settles without moving real money (no external gateway). */
export function railIsSimulated(id: string): boolean {
  if (id === "usdc-testnet") return !process.env.AEGIS_CIRCLE_API_KEY;
  // sandbox and ach-lite are in-process/mock executors by design — they
  // settle with local refs and never leave the app. Honest labeling (P0-2):
  // no external gateway exists for either, so they are simulated.
  return true;
}

/** Why a rail is currently simulated (or not) — for the UI/API, P0-2. */
export function railSimulationReason(id: string): string {
  if (id === "usdc-testnet") {
    return process.env.AEGIS_CIRCLE_API_KEY
      ? "Circle sandbox gateway configured — real USDC testnet settlement."
      : "No AEGIS_CIRCLE_API_KEY configured — settles with a deterministic simulated on-chain reference.";
  }
  if (id === "ach-lite") {
    return "Mock bank rail — settles with a synthetic ach:// reference. No real bank gateway exists.";
  }
  return "In-process demo rail — settles instantly inside the app with local:// refs. No real money moves.";
}
