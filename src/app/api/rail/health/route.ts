import type { NextRequest } from "next/server";
import { authenticate, error, json } from "@/core/api";
import { getWallet } from "@/core/store";

export const runtime = "nodejs";

/**
 * Agent health check. Demonstrates that the agent can verify its own
 * scoped identity but can read nothing it should not.
 */
export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  if (!claims) return error("Missing or invalid credentials", 401);

  if (claims.scope === "agent") {
    const wallet = await getWallet(claims.walletId);
    return json({
      authenticated: true,
      scope: "agent",
      wallet: wallet ? { id: wallet.id, status: wallet.status } : null,
      canDo: ["requestTransfer"],
    });
  }

  return json({
    authenticated: true,
    scope: "owner",
    canDo: ["managePolicy", "freeze", "revoke", "viewAudit"],
  });
}
