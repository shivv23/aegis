import type { RiskFactor, RiskLevel, RiskVerdict, Transaction, Wallet } from "./types";

/**
 * Deterministic pre-transaction risk scoring (0–100). Heuristics only — no
 * external AI dependency, so the guard works offline and in tests. Pure by
 * construction: same inputs, same score.
 */

export const STEP_UP_THRESHOLD = 55;
export const CRITICAL_THRESHOLD = 85;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round = (n: number) => Math.round(n * 10) / 10;

export function riskLevel(score: number): RiskLevel {
  if (score >= CRITICAL_THRESHOLD) return "CRITICAL";
  if (score >= STEP_UP_THRESHOLD) return "HIGH";
  if (score >= 25) return "MEDIUM";
  return "LOW";
}

export interface RiskInput {
  wallet: Wallet;
  amount: number;
  to: string;
  purpose: string;
  history: Transaction[];
  now: number;
}

const PURPOSE_RED_FLAGS =
  /\b(drain|withdraw|refund|emergency|recover|reset|secret|key|all)\b/i;

function hourAnomaly(now: number): number {
  const hour = new Date(now).getUTCHours();
  return hour >= 22 || hour < 6 ? 10 : 0;
}

function amountVsCap(wallet: Wallet, amount: number): RiskFactor {
  const ratio = clamp(amount / Math.max(1, wallet.policy.maxPerTx), 0, 1);
  return {
    name: "amount_vs_cap",
    points: round(ratio * 30),
    reason: `Amount is ${Math.round(ratio * 100)}% of the per-transaction cap`,
  };
}

function amountVsDaily(wallet: Wallet, amount: number, spentLast24h: number): RiskFactor {
  const remaining = Math.max(0, wallet.policy.dailyLimit - spentLast24h);
  const ratio = remaining <= 0 ? 1 : clamp(amount / remaining, 0, 1);
  return {
    name: "amount_vs_daily_remaining",
    points: round(ratio * 25),
    reason: `Consumes ${Math.round(ratio * 100)}% of remaining daily budget`,
  };
}

function newPayee(history: Transaction[], to: string): RiskFactor | null {
  const paidBefore = history.some((t) => t.to === to && t.status !== "BLOCKED");
  return paidBefore
    ? null
    : {
        name: "new_payee",
        points: 15,
        reason: "Counterparty has never been paid before",
      };
}

function burst(
  wallet: Wallet,
  history: Transaction[],
  now: number,
): RiskFactor {
  const minuteMs = 60 * 1000;
  const recent = history.filter((t) => now - t.requestedAt < minuteMs).length;
  const limit = Math.max(1, wallet.policy.velocityLimitPerMin);
  const ratio = clamp(recent / limit, 0, 1);
  return {
    name: "velocity_burst",
    points: round(ratio * 20),
    reason: `${recent} transfers in the last minute (${Math.round(ratio * 100)}% of velocity budget)`,
  };
}

function purposeFlag(purpose: string): RiskFactor | null {
  if (!PURPOSE_RED_FLAGS.test(purpose)) return null;
  return {
    name: "purpose_red_flag",
    points: 25,
    reason: `Purpose text matches a high-risk pattern: "${purpose}"`,
  };
}

/**
 * Scores a transfer before it enters the holding window. Returns factors and
 * a 0–100 score. The rail calls this only after the hard guard has passed.
 */
export function scoreTransfer(input: RiskInput): RiskVerdict {
  const { wallet, amount, to, purpose, history, now } = input;

  const dayMs = 24 * 60 * 60 * 1000;
  const spentLast24h = history
    .filter((t) => now - t.requestedAt < dayMs && t.status !== "BLOCKED")
    .reduce((sum, t) => sum + t.amount, 0);

  const factors: RiskFactor[] = [];
  const push = (f: RiskFactor | null) => {
    if (f) factors.push(f);
  };

  push(amountVsCap(wallet, amount));
  push(amountVsDaily(wallet, amount, spentLast24h));
  push(newPayee(history, to));
  factors.push(burst(wallet, history, now));
  push(purposeFlag(purpose));
  if (hourAnomaly(now) > 0) {
    factors.push({
      name: "hour_anomaly",
      points: hourAnomaly(now),
      reason: "Transfer during unusual hours (UTC 22:00–06:00)",
    });
  }

  const score = round(Math.min(100, factors.reduce((sum, f) => sum + f.points, 0)));
  return { score, level: riskLevel(score), factors };
}
