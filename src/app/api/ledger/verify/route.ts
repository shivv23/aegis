import type { NextRequest } from "next/server";
import { authenticate, authorizeRead, error, json } from "@/core/api";
import { verifyLedger } from "@/core/store";

export const runtime = "nodejs";

/**
 * GET /api/ledger/verify
 * Recomputes the hash chain across every transaction and audit entry. Any
 * tamper — edited amount, swapped row, deleted record — breaks the chain.
 */
export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorizeRead(claims);
  if (!authz.ok) return error(authz.reason!, 401);

  const proof = await verifyLedger();
  return json({
    ...proof,
    message: proof.intact
      ? "Ledger integrity verified: hash chain intact."
      : `Ledger tampered at seq ${proof.brokenAt?.seq} (${proof.brokenAt?.table})!`,
  });
}
