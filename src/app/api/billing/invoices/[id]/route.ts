import type { NextRequest } from "next/server";
import { authenticate, authorize, error, json } from "@/core/api";
import { addAudit } from "@/core/store";
import { finalizeInvoice, getInvoice } from "@/core/usage";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const claims = await authenticate(_req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);
  const { id } = await params;
  const invoice = await getInvoice(id);
  if (!invoice) return error("Invoice not found", 404);
  return json({ invoice });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);
  const { id } = await params;
  const invoice = await finalizeInvoice(id);
  if (!invoice) return error("Invoice not found", 404);

  await addAudit({
    walletId: invoice.walletId,
    actor: "owner",
    action: "INVOICE_FINALIZED",
    details: `Invoice ${invoice.id.slice(0, 8)} finalized ($${invoice.totalFeeUsd.toFixed(2)} fees)`,
  });

  return json({ invoice });
}
