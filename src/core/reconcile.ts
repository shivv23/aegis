/**
 * Reconciliation job (A5): match settled ledger rows against their rail
 * external references and report breaks.
 *
 * For simulated rails (sandbox, ach-lite, usdc without a gateway key) the
 * reference is deterministic — we re-derive it from the immutable settlement
 * fields and compare. For gateway-backed rails we verify the reference is
 * present and well-formed (we cannot recompute a real chain hash).
 */
import { randomUUID } from "node:crypto";
import { deriveExternalRef } from "./rails";
import type { Transaction } from "./types";

export type BreakKind = "MISSING_REF" | "REF_MISMATCH" | "MALFORMED_REF";

export interface ReconciliationBreak {
  txId: string;
  walletId: string;
  rail: string;
  kind: BreakKind;
  expected: string;
  actual: string;
}

export interface ReconciliationReport {
  id: string;
  runAt: number;
  total: number;
  matched: number;
  breaks: number;
  breaksList: ReconciliationBreak[];
}

export function validateExternalRef(rail: string, ref: string): boolean {
  switch (rail) {
    case "sandbox":
      return ref.startsWith("local://");
    case "usdc-testnet":
      return /^0x[0-9a-fA-F]{40}$/.test(ref) || ref.length >= 20;
    case "ach-lite":
      return ref.startsWith("ach://");
    default:
      return ref.length > 0;
  }
}

/** Simulated rails have deterministic refs we can recompute for reconciliation. */
function railIsSimulatedByRail(rail: string): boolean {
  switch (rail) {
    case "sandbox":
    case "ach-lite":
      return true;
    case "usdc-testnet":
      return !process.env.AEGIS_CIRCLE_API_KEY;
    default:
      return false;
  }
}

export async function reconcileSettledTransactions(
  settled: Transaction[],
): Promise<ReconciliationReport> {
  const breaksList: ReconciliationBreak[] = [];

  for (const tx of settled) {
    const rail = tx.rail ?? "sandbox";
    const ref = tx.externalRef ?? "";

    if (!ref) {
      breaksList.push({
        txId: tx.id,
        walletId: tx.walletId,
        rail,
        kind: "MISSING_REF",
        expected: "external reference",
        actual: "(none)",
      });
      continue;
    }

    if (!validateExternalRef(rail, ref)) {
      breaksList.push({
        txId: tx.id,
        walletId: tx.walletId,
        rail,
        kind: "MALFORMED_REF",
        expected: "valid rail reference",
        actual: ref,
      });
      continue;
    }

    if (railIsSimulatedByRail(rail)) {
      const hash = deriveExternalRef({
        walletId: tx.walletId,
        to: tx.to,
        amount: tx.amount,
        nonce: tx.nonce,
        requestedAt: tx.requestedAt,
      });
      const expectedRef =
        rail === "sandbox"
          ? `local://${tx.id}`
          : rail === "ach-lite"
            ? `ach://${hash.slice(2, 12)}`
            : hash;
      if (ref !== expectedRef) {
        breaksList.push({
          txId: tx.id,
          walletId: tx.walletId,
          rail,
          kind: "REF_MISMATCH",
          expected: expectedRef,
          actual: ref,
        });
      }
    }
  }

  return {
    id: randomUUID(),
    runAt: Date.now(),
    total: settled.length,
    matched: settled.length - breaksList.length,
    breaks: breaksList.length,
    breaksList,
  };
}
