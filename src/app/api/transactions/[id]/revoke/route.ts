import type { NextRequest } from "next/server";
import { authenticate, authorize, error, json } from "@/core/api";
import { addAudit, getTransaction, settleDue, transitionTransaction } from "@/core/store";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  await settleDue();
  const tx = await getTransaction(id);
  if (!tx) return error("Transaction not found", 404);

  if (tx.status !== "PENDING") {
    return error(`Cannot revoke a transaction in state '${tx.status}'`, 409);
  }

  const revoked = await transitionTransaction(id, "REVOKED", {
    rejectionReason: "IN_FLIGHT_REVOKED",
    revokedAt: Date.now(),
  });

  await addAudit({
    walletId: tx.walletId,
    actor: "owner",
    action: "TX_REVOKED_IN_FLIGHT",
    details: `Owner revoked ${tx.amount} to ${tx.to} mid-flight`,
  });

  return json({ transaction: revoked });
}
