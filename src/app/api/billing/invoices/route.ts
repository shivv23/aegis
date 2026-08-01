import type { NextRequest } from "next/server";
import { authenticate, authorize, error, json } from "@/core/api";
import { addAudit, listWallets } from "@/core/store";
import { feeScheduleTable, generateInvoice, listInvoices } from "@/core/usage";

export const runtime = "nodejs";

/**
 * GET  /api/billing/invoices           list invoices (newest first)
 * POST /api/billing/invoices           generate a draft invoice from usage rows
 */
export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);
  return json({ invoices: await listInvoices(), fees: feeScheduleTable() });
}

export async function POST(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const body = await req.json().catch(() => ({})) as {
    walletId?: string;
    periodStart?: number;
    periodEnd?: number;
  };
  const dayMs = 24 * 60 * 60 * 1000;
  const periodEnd = body.periodEnd ?? Date.now();
  const periodStart = body.periodStart ?? periodEnd - 30 * dayMs;

  const wallets = await listWallets();
  const wallet = wallets.find((w) => w.id === (body.walletId ?? wallets[0]?.id));
  if (!wallet) return error("No wallet to bill", 400);

  const invoice = await generateInvoice({
    walletId: wallet.id,
    periodStart,
    periodEnd,
  });
  if (!invoice) {
    return error("No usage rows in this period", 404);
  }

  await addAudit({
    walletId: wallet.id,
    actor: "owner",
    action: "INVOICE_GENERATED",
    details: `Invoice ${invoice.id.slice(0, 8)} for $${invoice.totalUsd.toFixed(2)} (fee $${invoice.totalFeeUsd.toFixed(2)})`,
  });

  return json({ invoice });
}
