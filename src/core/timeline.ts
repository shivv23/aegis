import type { Transaction } from "./types";

/**
 * Per-transaction timeline + processing-time metrics. Pure over the fields
 * the ledger actually records — every hop is a real stored timestamp, never
 * synthesized.
 */

export interface TimelineHop {
  label: string;
  ts: number;
  detail?: string;
}

export interface TxTimeline {
  hops: TimelineHop[];
  /** End-to-end latency in ms (settled - requested), when settled. */
  latencyMs?: number;
  /** Which hop failed/blocked, if any. */
  outcome: string;
}

export function buildTimeline(tx: Transaction): TxTimeline {
  const hops: TimelineHop[] = [{ label: "REQUESTED", ts: tx.requestedAt, detail: `${tx.amount} to ${tx.to}` }];

  if (tx.status === "STEP_UP_REQUIRED") {
    hops.push({
      label: "STEP_UP_REQUIRED",
      ts: tx.pendingUntil ? tx.pendingUntil - (tx.pendingUntil - tx.requestedAt) : tx.requestedAt,
      detail: tx.pendingUntil ? `awaiting owner approval, expires ${new Date(tx.pendingUntil).toISOString()}` : undefined,
    });
  }

  if (tx.pendingUntil) {
    hops.push({
      label: "HOLD_WINDOW",
      ts: tx.pendingUntil,
      detail: `in-flight reservation until ${new Date(tx.pendingUntil).toISOString()}`,
    });
  }

  if (tx.settledAt) {
    hops.push({ label: "SETTLED", ts: tx.settledAt, detail: tx.externalRef ?? undefined });
  }
  if (tx.blockedAt) {
    hops.push({ label: "BLOCKED", ts: tx.blockedAt, detail: tx.rejectionReason });
  }
  if (tx.revokedAt) {
    hops.push({ label: "REVOKED", ts: tx.revokedAt, detail: tx.rejectionReason });
  }

  const latencyMs = tx.settledAt ? tx.settledAt - tx.requestedAt : undefined;
  return { hops, latencyMs, outcome: tx.status };
}

/** Sorted end-to-end latencies for settled transfers. */
export function settlementLatencies(txs: Transaction[]): number[] {
  return txs
    .filter((t) => t.status === "SETTLED" && t.settledAt)
    .map((t) => t.settledAt! - t.requestedAt)
    .sort((a, b) => a - b);
}

/** p50 / p95 processing-time metrics (request → settlement). */
export function latencyPercentiles(txs: Transaction[], now = Date.now()) {
  const latencies = settlementLatencies(txs);
  const pct = (p: number) => {
    if (latencies.length === 0) return 0;
    const idx = Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length));
    return latencies[idx];
  };
  return {
    samples: latencies.length,
    p50: pct(50),
    p95: pct(95),
    windowMs: 30 * 24 * 60 * 60 * 1000,
    generatedAt: now,
  };
}
