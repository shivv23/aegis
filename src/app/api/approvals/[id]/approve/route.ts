import type { NextRequest } from "next/server";
import { authenticate, authorize, error, json } from "@/core/api";
import { approveApproval } from "@/core/store";

export const runtime = "nodejs";

/**
 * POST /api/approvals/:id/approve
 *
 * A registered signer (owner-scoped key carrying `keyId`) approves an open
 * owner-key issuance. When the 2-of-3 threshold is crossed the owner key is
 * minted and returned to this caller exactly once.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);
  if (!claims!.keyId) return error("Signer key required", 403);

  const { id } = await params;
  try {
    const { approval, mintedKey } = await approveApproval(id, claims!.keyId);
    return json(
      {
        approval,
        thresholdReached: Boolean(mintedKey),
        ...(mintedKey ? { ownerKey: mintedKey } : {}),
      },
      mintedKey ? 201 : 200,
    );
  } catch (err) {
    return error(err instanceof Error ? err.message : "Approval failed", 409);
  }
}
