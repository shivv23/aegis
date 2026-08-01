import { runGuard, spendContext } from "./guard";
import type { RejectionReason, Transaction, WalletPolicy } from "./types";

/**
 * What-if policy simulator. Replays a wallet's actual transaction history
 * against a hypothetical policy, using the same guard and the same
 * reservation-on-approval semantics the live rail uses. Nothing is written —
 * this is a pure read-only replay.
 */

export interface SimulatedDecision {
  txId: string;
  amount: number;
  to: string;
  purpose: string;
  at: number;
  actual: Transaction["status"];
  wouldBe: "ALLOWED" | "BLOCKED";
  reason?: RejectionReason;
  details?: string;
}

export interface SimulationSummary {
  total: number;
  wouldSettle: number;
  wouldBlock: number;
  actuallyBlocked: number;
  newlyBlocked: number;
  previouslyBlockedNowAllowed: number;
}

export interface SimulationResult {
  policy: WalletPolicy;
  decisions: SimulatedDecision[];
  summary: SimulationSummary;
}

export function simulatePolicy(
  policy: WalletPolicy,
  history: Transaction[],
): SimulationResult {
  const chronological = [...history].sort(
    (a, b) => a.requestedAt - b.requestedAt,
  );

  const decisions: SimulatedDecision[] = [];
  const wouldBeAllowed: Transaction[] = [];

  for (const tx of chronological) {
    const context = spendContext(tx.walletId, tx.requestedAt, wouldBeAllowed);
    const verdict = runGuard(
      {
        id: tx.walletId,
        name: "simulated",
        ownerDid: "simulated",
        status: "ACTIVE",
        balance: Number.MAX_SAFE_INTEGER,
        policy,
        createdAt: tx.requestedAt,
      },
      tx.amount,
      tx.to,
      context,
    );

    const decision: SimulatedDecision = {
      txId: tx.id,
      amount: tx.amount,
      to: tx.to,
      purpose: tx.purpose,
      at: tx.requestedAt,
      actual: tx.status,
      wouldBe: verdict.allowed ? "ALLOWED" : "BLOCKED",
      reason: verdict.reason,
      details: verdict.details,
    };
    decisions.push(decision);

    if (verdict.allowed) {
      // Reservation-on-approval: an allowed tx counts against limits even
      // before it settles, exactly like the live guard.
      wouldBeAllowed.push(tx);
    }
  }

  const summary: SimulationSummary = {
    total: decisions.length,
    wouldSettle: decisions.filter((d) => d.wouldBe === "ALLOWED").length,
    wouldBlock: decisions.filter((d) => d.wouldBe === "BLOCKED").length,
    actuallyBlocked: decisions.filter(
      (d) => d.actual === "BLOCKED" || d.actual === "REVOKED",
    ).length,
    newlyBlocked: decisions.filter(
      (d) => d.wouldBe === "BLOCKED" && d.actual === "SETTLED",
    ).length,
    previouslyBlockedNowAllowed: decisions.filter(
      (d) => d.wouldBe === "ALLOWED" && (d.actual === "BLOCKED" || d.actual === "REVOKED"),
    ).length,
  };

  return { policy, decisions, summary };
}
