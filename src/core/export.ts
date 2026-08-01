import type { Transaction, AuditLogEntry } from "./types";

/**
 * Regulator export: audit pack (CSV) + SAR-lite monthly report (JSON).
 * Pure functions over the ledger — no DB access, easy to test.
 */

function csvEscape(value: string | number | undefined): string {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Array<Record<string, string | number | undefined>>): string {
  const cols = rows.length > 0 ? Object.keys(rows[0]) : [];
  const lines = [cols.join(",")];
  for (const row of rows) {
    lines.push(cols.map((c) => csvEscape(row[c])).join(","));
  }
  return lines.join("\n");
}

/** Full audit pack as CSV — every transaction row a judge can open in Excel. */
export function auditPackCsv(txs: Transaction[]): string {
  return toCsv(
    txs.map((t) => ({
      id: t.id,
      wallet: t.walletId,
      from: t.from,
      to: t.to,
      amount: t.amount,
      purpose: t.purpose,
      status: t.status,
      rejection_reason: t.rejectionReason ?? "",
      requested_at: new Date(t.requestedAt).toISOString(),
      settled_at: t.settledAt ? new Date(t.settledAt).toISOString() : "",
      nonce: t.nonce,
      step_up_score: t.stepUpScore ?? "",
      external_ref: t.externalRef ?? "",
    })),
  );
}

export interface SarLiteReport {
  generatedAt: string;
  period: string;
  totals: {
    txs: number;
    settledTxs: number;
    settledUsd: number;
    blockedTxs: number;
    blockedUsd: number;
    stepUpRequired: number;
    revoked: number;
  };
  /** Counterparties whose activity triggers a reportable-threshold flag. */
  flagged: Array<{
    to: string;
    settledUsd: number;
    txCount: number;
    flags: string[];
  }>;
  blockedReasons: Record<string, number>;
}

/** Monthly summary with heuristic SAR-lite thresholds (e.g. $10k / 100 tx). */
export function sarLiteReport(
  txs: Transaction[],
  now = Date.now(),
  thresholds = { usd: 10000, txCount: 100 },
): SarLiteReport {
  const monthStart = now - 30 * 24 * 60 * 60 * 1000;
  const inRange = txs.filter((t) => t.requestedAt >= monthStart);

  const byCounterparty = new Map<string, { settledUsd: number; txCount: number }>();
  const blockedReasons: Record<string, number> = {};
  for (const t of inRange) {
    if (t.status === "SETTLED") {
      const e = byCounterparty.get(t.to) ?? { settledUsd: 0, txCount: 0 };
      e.settledUsd += t.amount;
      e.txCount += 1;
      byCounterparty.set(t.to, e);
    }
    if (t.status === "BLOCKED" && t.rejectionReason) {
      blockedReasons[t.rejectionReason] = (blockedReasons[t.rejectionReason] ?? 0) + 1;
    }
  }

  const flagged = [...byCounterparty.entries()]
    .map(([to, e]) => {
      const flags: string[] = [];
      if (e.settledUsd >= thresholds.usd) flags.push(`settled_${e.settledUsd.toFixed(0)}_gt_${thresholds.usd}`);
      if (e.txCount >= thresholds.txCount) flags.push(`tx_count_${e.txCount}_gt_${thresholds.txCount}`);
      return { to, settledUsd: e.settledUsd, txCount: e.txCount, flags };
    })
    .filter((f) => f.flags.length > 0)
    .sort((a, b) => b.settledUsd - a.settledUsd);

  return {
    generatedAt: new Date(now).toISOString(),
    period: new Date(monthStart).toISOString().slice(0, 10),
    totals: {
      txs: inRange.length,
      settledTxs: inRange.filter((t) => t.status === "SETTLED").length,
      settledUsd: inRange.filter((t) => t.status === "SETTLED").reduce((s, t) => s + t.amount, 0),
      blockedTxs: inRange.filter((t) => t.status === "BLOCKED").length,
      blockedUsd: inRange.filter((t) => t.status === "BLOCKED").reduce((s, t) => s + t.amount, 0),
      stepUpRequired: inRange.filter((t) => t.status === "STEP_UP_REQUIRED").length,
      revoked: inRange.filter((t) => t.status === "REVOKED").length,
    },
    flagged,
    blockedReasons,
  };
}

/** Serialize an audit log into CSV for regulator review. */
export function auditLogCsv(log: AuditLogEntry[]): string {
  return toCsv(
    log.map((e) => ({
      id: e.id,
      wallet: e.walletId,
      actor: e.actor,
      action: e.action,
      details: e.details,
      timestamp: new Date(e.timestamp).toISOString(),
    })),
  );
}
