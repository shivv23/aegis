import type { NextRequest } from "next/server";
import { authenticate, authorize, error, json } from "@/core/api";
import { rejectApproval } from "@/core/store";

export const runtime = "nodejs";

/**
 * POST /api/approvals/:id/reject — a registered signer rejects the request.
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
    const approval = await rejectApproval(id, claims!.keyId);
    return json({ approval });
  } catch (err) {
    return error(err instanceof Error ? err.message : "Reject failed", 409);
  }
}
