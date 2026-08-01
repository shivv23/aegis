import type { NextRequest } from "next/server";
import { authenticate, authorize, error, json } from "@/core/api";
import { addAudit, removeSigner } from "@/core/store";

export const runtime = "nodejs";

/**
 * DELETE /api/signers/:id — master key only. Removes a multi-sig signer.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);
  if (claims!.walletId !== "*") return error("Only the master key can remove signers", 403);

  const { id } = await params;
  const removed = await removeSigner(id);
  if (!removed) return error("Signer not found", 404);

  await addAudit({
    walletId: "*",
    actor: "owner",
    action: "SIGNER_REMOVED",
    details: `Multi-sig signer ${id.slice(0, 8)}… removed`,
  });
  return json({ removed: true });
}
