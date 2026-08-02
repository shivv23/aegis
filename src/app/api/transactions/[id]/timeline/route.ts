import type { NextRequest } from "next/server";
import { authenticate, authorizeRead, authorizeWalletOrg, error, json } from "@/core/api";
import { getTransaction } from "@/core/store";
import { buildTimeline } from "@/core/timeline";

export const runtime = "nodejs";

/**
 * GET /api/transactions/:id/timeline — per-tx audit trail:
 * requested → (step-up) → (hold window) → settled/blocked/revoked,
 * with actor + latency at each hop. Renders the timeline drawer.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const claims = await authenticate(req);
  const authz = authorizeRead(claims);
  if (!authz.ok) return error(authz.reason!, 401);

  const tx = await getTransaction(id);
  if (!tx) return error("Transaction not found", 404);
  const orgz = authorizeWalletOrg(claims, tx.walletId);
  if (!orgz.ok) return error(orgz.reason!, 403);

  return json({ transaction: tx, timeline: buildTimeline(tx) });
}
