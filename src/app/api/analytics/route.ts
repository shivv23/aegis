import type { NextRequest } from "next/server";
import { authenticate, authorizeRead, error, json } from "@/core/api";
import { listBudgetGroups, listTransactions, settleDue } from "@/core/store";
import { forecastAll } from "@/core/budget";
import { detectStructuring } from "@/core/structuring";
import { latencyPercentiles } from "@/core/timeline";

export const runtime = "nodejs";

const DAY = 24 * 60 * 60 * 1000;

export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorizeRead(claims);
  if (!authz.ok) return error(authz.reason!, 401);

  await settleDue();
  const txs = await listTransactions();

  const funnel = {
    total: txs.length,
    settled: txs.filter((t) => t.status === "SETTLED").length,
    blocked: txs.filter((t) => t.status === "BLOCKED").length,
    pending: txs.filter((t) => t.status === "PENDING").length,
    revoked: txs.filter((t) => t.status === "REVOKED").length,
    stepUp: txs.filter((t) => t.status === "STEP_UP_REQUIRED").length,
    settledUsd: txs.filter((t) => t.status === "SETTLED").reduce((s, t) => s + t.amount, 0),
  };

  const blockedReasons: Record<string, number> = {};
  for (const t of txs) {
    if (t.status === "BLOCKED" && t.rejectionReason) {
      blockedReasons[t.rejectionReason] = (blockedReasons[t.rejectionReason] ?? 0) + 1;
    }
  }

  const now = Date.now();
  const days: Array<{ day: string; settled: number; blocked: number }> = [];
  for (let i = 6; i >= 0; i--) {
    const start = now - i * DAY;
    const end = start + DAY;
    const inRange = txs.filter((t) => t.requestedAt >= start && t.requestedAt < end);
    days.push({
      day: new Date(start).toISOString().slice(5, 10),
      settled: inRange.filter((t) => t.status === "SETTLED").reduce((s, t) => s + t.amount, 0),
      blocked: inRange.filter((t) => t.status === "BLOCKED").length,
    });
  }

  const byPurpose: Array<{ purpose: string; count: number; usd: number; blocked: number }> = [];
  const purposeMap = new Map<string, { count: number; usd: number; blocked: number }>();
  for (const t of txs) {
    const e = purposeMap.get(t.purpose) ?? { count: 0, usd: 0, blocked: 0 };
    e.count += 1;
    if (t.status === "SETTLED") e.usd += t.amount;
    if (t.status === "BLOCKED") e.blocked += 1;
    purposeMap.set(t.purpose, e);
  }
  for (const [purpose, e] of purposeMap) byPurpose.push({ purpose, ...e });
  byPurpose.sort((a, b) => b.usd - a.usd);

  const budgets = forecastAll(await listBudgetGroups(), txs, now);
  const latency = latencyPercentiles(txs, now);
  const structuring = detectStructuring(txs, now);

  return json({
    funnel,
    blockedReasons,
    dailySpend: days,
    byPurpose: byPurpose.slice(0, 8),
    budgets,
    latency,
    structuring: structuring.map((c) => ({
      walletId: c.walletId,
      to: c.to,
      date: c.date,
      count: c.count,
      totalUsd: c.totalUsd,
      avgUsd: c.avgUsd,
      jointThreshold: c.jointThreshold,
      smallPaymentCap: c.smallPaymentCap,
      flagged: c.flagged,
    })),
  });
}
