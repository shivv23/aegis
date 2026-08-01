import type { NextRequest } from "next/server";
import { authenticate, authorize, authorizeWalletOrg, error, json } from "@/core/api";
import { addAudit, getWallet, setWalletStatus } from "@/core/store";

export const runtime = "nodejs";

async function handle(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
  freeze: boolean,
) {
  const { id } = await params;
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const existing = await getWallet(id);
  if (!existing) return error("Wallet not found", 404);
  const orgz = authorizeWalletOrg(claims, existing.orgId);
  if (!orgz.ok) return error(orgz.reason!, 403);

  const wallet = await setWalletStatus(id, freeze ? "FROZEN" : "ACTIVE");
  if (!wallet) return error("Wallet not found", 404);

  await addAudit({
    walletId: id,
    actor: "owner",
    action: freeze ? "WALLET_FROZEN" : "WALLET_UNFROZEN",
    details: freeze
      ? "Kill switch engaged. All transfers blocked and in-flight transactions revoked."
      : "Kill switch released. Wallet resumed normal operation.",
  });

  return json({ wallet });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(req, { params }, true);
}
