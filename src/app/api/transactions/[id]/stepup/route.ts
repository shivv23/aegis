import type { NextRequest } from "next/server";
import { z } from "zod";
import { authenticate, authorize, error, json } from "@/core/api";
import { approveStepUp, declineStepUp, expireStepUps, getTransaction } from "@/core/store";

export const runtime = "nodejs";

const bodySchema = z.object({
  action: z.enum(["approve", "decline"]),
});

/**
 * POST /api/transactions/:id/stepup
 *
 * Owner decision on a high-risk transfer that the risk engine flagged as
 * STEP_UP_REQUIRED. Approve → the transfer enters the normal holding window;
 * decline → it is blocked.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error("Invalid decision payload", 400);

  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  await expireStepUps();
  const tx = await getTransaction(id);
  if (!tx) return error("Transaction not found", 404);

  if (claims!.walletId !== tx.walletId && claims!.walletId !== "*") {
    return error("Key is not authorized for this wallet", 403);
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
