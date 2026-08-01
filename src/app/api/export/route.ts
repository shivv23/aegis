import type { NextRequest } from "next/server";
import { authenticate, authorize, error, json } from "@/core/api";
import { listAudit, listTransactions } from "@/core/store";
import { auditLogCsv, auditPackCsv, sarLiteReport } from "@/core/export";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const kind = req.nextUrl.searchParams.get("kind") ?? "report";
  const txs = await listTransactions();

  if (kind === "audit.csv") {
    return new Response(auditPackCsv(txs), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="aegis-audit.csv"',
      },
    });
  }
  if (kind === "auditlog.csv") {
    const log = await listAudit();
    return new Response(auditLogCsv(log), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="aegis-audit-log.csv"',
      },
    });
  }
  if (kind === "audit.json") {
    return json({ generatedAt: new Date().toISOString(), transactions: txs });
  }

  return json(sarLiteReport(txs));
}
