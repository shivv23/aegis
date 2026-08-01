import type { NextRequest } from "next/server";
import { authenticate, authorize, error, json } from "@/core/api";
import {
  getBreakerState,
  listAgentKeys,
  listApprovals,
  listBudgetGroups,
  listTransactions,
  listWallets,
  verifyLedger,
} from "@/core/store";
import { forecastAll } from "@/core/budget";
import { money, shortId } from "@/lib/utils";
import type { LedgerProof } from "@/core/types";

export const runtime = "nodejs";

type Severity = "info" | "warning" | "critical";

interface AlertItem {
  id: string;
  type: string;
  severity: Severity;
  title: string;
  detail: string;
  at: number;
  link: string;
}

const DAY = 24 * 60 * 60 * 1000;
const KEY_EXPIRY_WINDOW_MS = 7 * DAY;
const STUCK_HOLD_MS = 60 * 1000;

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/**
 * GET /api/alerts
 * Aggregated "needs my attention" feed over transactions, approvals, budget
 * burn, breaker state, agent keys, and ledger integrity. Each source degrades
 * gracefully so one failure never blanks the whole feed.
 */
export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const [txs, approvals, groups, wallets, keys, proof] = await Promise.all([
    safe(() => listTransactions(), []),
    safe(() => listApprovals(), []),
    safe(() => listBudgetGroups(), []),
    safe(() => listWallets(), []),
    safe(() => listAgentKeys(), []),
    safe<LedgerProof | null>(() => verifyLedger(), null),
  ]);

  const now = Date.now();
  const alerts: AlertItem[] = [];

  for (const tx of txs) {
    if (tx.status === "BLOCKED") {
      alerts.push({
        id: `tx-blocked-${tx.id}`,
        type: "tx.blocked",
        severity: "critical",
        title: `Transfer blocked${tx.rejectionReason ? `: ${tx.rejectionReason}` : ""}`,
        detail: `${money(tx.amount)} to ${shortId(tx.to, 20)} held by the guard${tx.purpose ? ` · ${tx.purpose}` : ""}`,
        at: tx.blockedAt ?? tx.requestedAt,
        link: "/transactions",
      });
    } else if (tx.status === "STEP_UP_REQUIRED") {
      alerts.push({
        id: `stepup-${tx.id}`,
        type: "approval.pending",
        severity: "warning",
        title: "Step-up approval required",
        detail: `${money(tx.amount)} to ${shortId(tx.to, 20)} needs an owner decision`,
        at: tx.requestedAt,
        link: "/transactions",
      });
    } else if (tx.status === "PENDING" && tx.pendingUntil && now - tx.pendingUntil > STUCK_HOLD_MS) {
      alerts.push({
        id: `stuck-${tx.id}`,
        type: "tx.frozen",
        severity: "warning",
        title: "Transfer pending past its settle window",
        detail: `${money(tx.amount)} to ${shortId(tx.to, 20)} never left the hold queue`,
        at: tx.pendingUntil,
        link: "/transactions",
      });
    } else if (tx.status === "REVOKED" && tx.rejectionReason === "IN_FLIGHT_REVOKED") {
      alerts.push({
        id: `inflight-${tx.id}`,
        type: "in_flight.revoked",
        severity: "info",
        title: "In-flight transfer revoked",
        detail: `${money(tx.amount)} to ${shortId(tx.to, 20)} revoked when the wallet froze`,
        at: tx.revokedAt ?? tx.requestedAt,
        link: "/transactions",
      });
    }
  }

  for (const approval of approvals) {
    if (approval.status === "PENDING") {
      alerts.push({
        id: `approval-${approval.id}`,
        type: "approval.pending",
        severity: "warning",
        title: "Multi-sig approval pending",
        detail: `${approval.operation} for "${approval.label}" — ${approval.approvers.length}/${approval.required} signers`,
        at: approval.createdAt,
        link: "/multisig",
      });
    } else if (approval.status === "EXPIRED") {
      alerts.push({
        id: `approval-expired-${approval.id}`,
        type: "approval.expired",
        severity: "warning",
        title: "Multi-sig approval expired",
        detail: `${approval.operation} for "${approval.label}" expired without enough signers`,
        at: approval.expiresAt,
        link: "/multisig",
      });
    }
  }

  for (const b of forecastAll(groups, txs, now)) {
    if (b.status === "on_track") continue;
    alerts.push({
      id: `budget-${b.groupId}`,
      type: "budget.warning",
      severity: b.status === "exhausted" ? "critical" : "warning",
      title: `Budget "${b.name}" ${b.status === "exhausted" ? "exhausted" : "near limit"}`,
      detail: `${money(b.spend)} of ${money(b.monthlyLimit)} spent (${Math.round(b.burnPct * 100)}%) · runway ${b.runwayDays === null ? "n/a" : `${b.runwayDays.toFixed(1)}d`}`,
      at: now,
      link: "/analytics",
    });
  }

  for (const w of wallets) {
    const breaker = getBreakerState(w.id, now);
    if (w.status === "FROZEN") {
      alerts.push({
        id: `frozen-${w.id}`,
        type: "tx.frozen",
        severity: "critical",
        title: `Kill switch engaged on ${w.name}`,
        detail: `${shortId(w.id)} is frozen — in-flight transfers were revoked`,
        at: now,
        link: "/wallet",
      });
    }
    if (breaker.tripped) {
      alerts.push({
        id: `breaker-${w.id}`,
        type: "breaker.tripped",
        severity: "critical",
        title: `Circuit breaker tripped on ${w.name}`,
        detail: `${breaker.anomalies}/${breaker.threshold} anomalies in the current window`,
        at: now,
        link: "/wallet",
      });
    }
  }

  for (const k of keys) {
    if (!k.expiresAt || k.revokedAt) continue;
    if (k.expiresAt - now > KEY_EXPIRY_WINDOW_MS) continue;
    alerts.push({
      id: `key-${k.publicKey}`,
      type: "key.expiring",
      severity: k.expiresAt < now ? "critical" : "warning",
      title: `Agent key expiring for ${shortId(k.walletId)}`,
      detail: `${k.label} expires ${new Date(k.expiresAt).toISOString().slice(0, 10)}`,
      at: k.expiresAt,
      link: "/sessions",
    });
  }

  if (proof && !proof.intact) {
    alerts.push({
      id: "ledger-broken",
      type: "ledger.broken",
      severity: "critical",
      title: "Ledger hash chain broken",
      detail: proof.brokenAt
        ? `Break at ${proof.brokenAt.table}#${proof.brokenAt.seq} after ${proof.rows} rows`
        : `Hash chain failed after ${proof.rows} rows`,
      at: now,
      link: "/audit",
    });
  }

  alerts.sort((a, b) => b.at - a.at);
  return json({ alerts: alerts.slice(0, 100) });
}
