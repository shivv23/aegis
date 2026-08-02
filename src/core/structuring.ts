import type { Transaction } from "./types";

/**
 * Structuring / smurfing detection (AML-lite).
 *
 * Flags clusters of many small same-beneficiary payments inside a window that
 * jointly breach a cap. This is an ALERT (never a hard block) — the guard
 * already reserves daily/monthly caps; structuring detection makes the
 * split-to-avoid-caps attempt *visible* as a named finding.
 */

export interface StructuringCluster {
  walletId: string;
  to: string;
  date: string;
  count: number;
  totalUsd: number;
  avgUsd: number;
  /** The cap the cluster jointly breached. */
  jointThreshold: number;
  smallPaymentCap: number;
  flagged: boolean;
}

export interface StructuringOptions {
  /** Min payments in the window before a cluster is considered. */
  minCount?: number;
  /** A payment is "small" if at or below this amount. */
  smallPaymentCap?: number;
  /** The cluster is flagged when its joint total breaches this. */
  jointThreshold?: number;
  windowMs?: number;
}

/**
 * Scans SETTLED transfers grouped by (wallet, beneficiary, UTC day). A cluster
 * is flagged when it has enough small payments whose joint total breaches the
 * threshold — the signature of someone splitting a transfer to dodge a cap.
 */
export function detectStructuring(
  txs: Transaction[],
  now = Date.now(),
  opts: StructuringOptions = {},
): StructuringCluster[] {
  const minCount = opts.minCount ?? 4;
  const smallPaymentCap = opts.smallPaymentCap ?? 50;
  const jointThreshold = opts.jointThreshold ?? 100;
  const windowMs = opts.windowMs ?? 24 * 60 * 60 * 1000;

  const groups = new Map<string, { walletId: string; to: string; date: string; amounts: number[] }>();

  for (const t of txs) {
    if (t.status !== "SETTLED" || t.kind === "deposit" || t.kind === "withdrawal") continue;
    const settledAt = t.settledAt ?? t.requestedAt;
    if (now - settledAt > windowMs) continue;
    const date = new Date(settledAt).toISOString().slice(0, 10);
    const key = `${t.walletId}:${t.to}:${date}`;
    const g = groups.get(key) ?? { walletId: t.walletId, to: t.to, date, amounts: [] };
    g.amounts.push(t.amount);
    groups.set(key, g);
  }

  const clusters: StructuringCluster[] = [];
  for (const g of groups.values()) {
    const totalUsd = g.amounts.reduce((s, a) => s + a, 0);
    const smallCount = g.amounts.filter((a) => a <= smallPaymentCap).length;
    const flagged =
      g.amounts.length >= minCount && smallCount >= minCount && totalUsd > jointThreshold;
    clusters.push({
      walletId: g.walletId,
      to: g.to,
      date: g.date,
      count: g.amounts.length,
      totalUsd: Math.round(totalUsd * 100) / 100,
      avgUsd: Math.round((totalUsd / g.amounts.length) * 100) / 100,
      jointThreshold,
      smallPaymentCap,
      flagged,
    });
  }
  return clusters.sort((a, b) => b.totalUsd - a.totalUsd);
}
