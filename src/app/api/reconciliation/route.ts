import type { NextRequest } from "next/server";
import { authenticate, authorize, error, json } from "@/core/api";
import { addAudit, latestReconciliationReport, listTransactions, saveReconciliationReport } from "@/core/store";
import { reconcileSettledTransactions } from "@/core/reconcile";

export const runtime = "nodejs";

/**
 * GET  /api/reconciliation        latest report
 * POST /api/reconciliation/run    run the job against settled transactions
 */
export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);
  const report = await latestReconciliationReport();
  return json({ report });
}

export async function POST(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const all = await listTransactions();
  const settled = all.filter((t) => t.status === "SETTLED");
  const report = await reconcileSettledTransactions(settled);
  await saveReconciliationReport(report);

  await addAudit({
    walletId: "*",
    actor: "system",
    action: "RECONCILIATION_RAN",
    details: `Matched ${report.matched}/${report.total} settled rows, ${report.breaks} break(s)`,
  });

  return json({ report });
}
