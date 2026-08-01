import { NextResponse } from "next/server";
import { verifyLedger } from "@/core/store";

export const runtime = "nodejs";

/**
 * Health endpoints (C5). /api/health is public — liveness + readiness with
 * a real ledger-verify check so uptime monitoring proves more than "the
 * process is up". No auth: monitoring agents don't hold keys.
 */
export async function GET() {
  const proof = await verifyLedger().catch(() => null);
  const dbOk = proof !== null;
  const status = dbOk && proof.intact ? 200 : 503;

  return NextResponse.json(
    {
      status: status === 200 ? "ok" : "degraded",
      checks: {
        ledger: proof ? { intact: proof.intact, rows: proof.rows } : { intact: false },
        db: dbOk,
      },
      uptime: process.uptime(),
      ts: Date.now(),
    },
    { status },
  );
}
