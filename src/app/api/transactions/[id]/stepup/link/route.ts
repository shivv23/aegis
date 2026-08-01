import type { NextRequest } from "next/server";
import { z } from "zod";
import { error, json } from "@/core/api";
import { verifyDecisionToken } from "@/core/keys";
import { approveStepUp, declineStepUp, expireStepUps, getTransaction } from "@/core/store";

export const runtime = "nodejs";

const bodySchema = z.object({
  token: z.string().min(1),
  action: z.enum(["approve", "decline"]),
});

/**
 * POST /api/transactions/:id/stepup/link
 *
 * One-tap approval from an email/Slack deep link. The bearer presents a short-
 * lived `aegis-decision` JWT (bound to this wallet + transaction + action) —
 * no owner key required. Used by /approve/[id]?token=… .
 */
/**
 * GET /api/transactions/:id/stepup/link?token=…
 *
 * View-only access to a step-up transaction granted by a valid decision link
 * (so the approval page can render without an owner key).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const token = req.nextUrl.searchParams.get("token");
  const claims = await verifyDecisionToken(token);
  if (!claims) return error("Expired or invalid decision link", 401);
  if (claims.txId !== id) return error("Decision link is not for this transaction", 403);

  const tx = await getTransaction(id);
  if (!tx) return error("Transaction not found", 404);
  if (tx.walletId !== claims.walletId) {
    return error("Decision link is not authorized for this wallet", 403);
  }
  return json({ transaction: tx });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error("Invalid decision payload", 400);

  const claims = await verifyDecisionToken(parsed.data.token);
  if (!claims) return error("Expired or invalid decision link", 401);
  if (claims.txId !== id) return error("Decision link is not for this transaction", 403);

  await expireStepUps();
  const tx = await getTransaction(id);
  if (!tx) return error("Transaction not found", 404);
  if (tx.walletId !== claims.walletId) {
    return error("Decision link is not authorized for this wallet", 403);
  }
  if (parsed.data.action !== claims.action) {
    return error("Decision link was minted for a different action", 403);
  }

  if (parsed.data.action === "approve") {
    const result = await approveStepUp(id);
    if (!result) {
      return error(`Transaction is not awaiting step-up (state '${tx.status}')`, 409);
    }
    return json({
      status: result.tx.status,
      message: "Approved. Transfer enters the holding window before settlement.",
      transaction: result.tx,
    });
  }

  const declined = await declineStepUp(id);
  if (!declined) {
    return error(`Transaction is not awaiting step-up (state '${tx.status}')`, 409);
  }
  return json({
    status: declined.status,
    message: "Declined. Transfer blocked.",
    transaction: declined,
  });
}
