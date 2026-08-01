import type { NextRequest } from "next/server";
import { authenticate, authorize, error, json } from "@/core/api";
import { addAudit, setWalletStatus } from "@/core/store";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const wallet = await setWalletStatus(id, "ACTIVE");
  if (!wallet) return error("Wallet not found", 404);

  await addAudit({
    walletId: id,
    actor: "owner",
    action: "WALLET_UNFROZEN",
    details: "Kill switch released. Wallet resumed normal operation.",
  });

  return json({ wallet });
}
