import type { NextRequest } from "next/server";
import { error, json } from "@/core/api";
import { expireStepUps, listTransactions, releaseExpiredBreakerFreezes, settleDue, verifyLedger } from "@/core/store";
import { sarLiteReport } from "@/core/export";

export const runtime = "nodejs";

const CRON_SECRET = process.env.AEGIS_CRON_SECRET;

/**
 * GET /api/cron/jobs — scheduled background jobs (C6).
 * Invoked by Vercel Cron (vercel.json) with the `x-vercel-cron` header, or by
 * anything that knows AEGIS_CRON_SECRET. Runs: settleDue tick (also promotes
 * policy versions), step-up expiry, circuit-breaker reset, ledger rechain
 * verify, plus a rolling 30-day SAR-lite digest report (E2). Idempotent and
 * safe to run on every tick.
 */
export async function GET(req: NextRequest) {
  const isVercelCron = req.headers.get("x-vercel-cron") === "1";
  const bearer = req.headers.get("authorization")?.replace(/^Bearer /i, "");
  const authorized = isVercelCron || (CRON_SECRET !== undefined && bearer === CRON_SECRET);
  if (!authorized) return error("Unauthorized", 401);

  const now = Date.now();
  const settled = await settleDue(now);
  const expired = await expireStepUps(now);
  const released = await releaseExpiredBreakerFreezes(now);
  const proof = await verifyLedger();
  const report = sarLiteReport(await listTransactions());

  return json({
    ts: now,
    settled: settled.length,
    expired: expired.length,
    released,
    ledgerIntact: proof.intact,
    report: {
      generatedAt: report.generatedAt,
      period: report.period,
      totals: report.totals,
      flagged: report.flagged.length,
    },
  });
}
