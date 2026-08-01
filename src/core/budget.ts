import type { BudgetGroup, Transaction } from "@/core/types";

const DAY = 24 * 60 * 60 * 1000;
const WINDOW_MS = 30 * DAY;

export type BurnStatus = "on_track" | "warning" | "exhausted";

export interface GroupBurn {
  groupId: string;
  name: string;
  monthlyLimit: number;
  spend: number;
  burnPct: number;
  ratePerDay: number;
  /** Days until the monthly limit is exhausted at the current rate (null = no spend yet). */
  runwayDays: number | null;
  /** Projected utilization of the monthly limit at day 30 on the current rate. */
  projectedPct: number;
  status: BurnStatus;
  walletCount: number;
  /** Cumulative spend per day over the last 7 days, with the limit as a reference line. */
  series: Array<{ day: string; spend: number; limit: number }>;
}

/** Effective timestamp of a transaction for budget accounting (settled = settle time). */
export function txTime(tx: Transaction): number {
  return tx.status === "SETTLED" && tx.settledAt ? tx.settledAt : tx.requestedAt;
}

/** Counts SETTLED + PENDING spend since a timestamp (blocked/revoked never count). */
export function spendSince(txs: Transaction[], since: number): number {
  return txs.reduce((sum, tx) => {
    if (tx.status !== "SETTLED" && tx.status !== "PENDING") return sum;
    return txTime(tx) >= since ? sum + tx.amount : sum;
  }, 0);
}

/**
 * The burn-rate basis: the earlier of the rolling-window start and the group's
 * earliest activity (or creation). Using earliest activity keeps a fresh group's
 * runway honest instead of diluting it over a full 30 days.
 */
export function periodStart(group: BudgetGroup, txs: Transaction[], now = Date.now()): number {
  const windowStart = now - WINDOW_MS;
  const inWindow = txs.filter((t) => txTime(t) >= windowStart);
  if (inWindow.length === 0) return Math.max(windowStart, group.createdAt);
  const earliest = Math.min(...inWindow.map(txTime));
  return Math.max(windowStart, earliest);
}

/** Pure forecast math — the number a CFO looks at. */
export function computeForecast(input: {
  limit: number;
  spend: number;
  periodStartMs: number;
  now?: number;
}): { burnPct: number; ratePerDay: number; runwayDays: number | null; projectedPct: number; status: BurnStatus } {
  const now = input.now ?? Date.now();
  const elapsedDays = Math.min(30, Math.max(1, (now - input.periodStartMs) / DAY));
  const ratePerDay = input.spend / elapsedDays;
  const burnPct = input.limit > 0 ? Math.min(1, input.spend / input.limit) : input.spend > 0 ? 1 : 0;
  const remaining = Math.max(0, input.limit - input.spend);
  const runwayDays = ratePerDay > 0 ? remaining / ratePerDay : null;
  const projectedPct = input.limit > 0 ? Math.min(1, (ratePerDay * 30) / input.limit) : 0;
  const status: BurnStatus = input.spend >= input.limit ? "exhausted" : projectedPct >= 0.8 ? "warning" : "on_track";
  return { burnPct, ratePerDay, runwayDays, projectedPct, status };
}

export function groupBurn(group: BudgetGroup, txs: Transaction[], now = Date.now()): GroupBurn {
  const groupTxs = txs.filter((t) => group.walletIds.includes(t.walletId));
  const windowStart = now - WINDOW_MS;
  const spend = spendSince(groupTxs, windowStart);
  const { burnPct, ratePerDay, runwayDays, projectedPct, status } = computeForecast({
    limit: group.monthlyLimit,
    spend,
    periodStartMs: periodStart(group, groupTxs, now),
    now,
  });

  const series: GroupBurn["series"] = [];
  for (let i = 6; i >= 0; i--) {
    const dayStart = now - i * DAY;
    const dayEnd = dayStart + DAY;
    const cumulative = groupTxs.reduce((sum, tx) => {
      if (tx.status !== "SETTLED" && tx.status !== "PENDING") return sum;
      const t = txTime(tx);
      return t >= windowStart && t < dayEnd ? sum + tx.amount : sum;
    }, 0);
    series.push({
      day: new Date(dayStart).toISOString().slice(5, 10),
      spend: cumulative,
      limit: group.monthlyLimit,
    });
  }

  return {
    groupId: group.id,
    name: group.name,
    monthlyLimit: group.monthlyLimit,
    spend,
    burnPct,
    ratePerDay,
    runwayDays,
    projectedPct,
    status,
    walletCount: group.walletIds.length,
    series,
  };
}

/** Forecasts every budget group from a single transaction listing. */
export function forecastAll(groups: BudgetGroup[], txs: Transaction[], now = Date.now()): GroupBurn[] {
  return groups.map((g) => groupBurn(g, txs, now));
}
