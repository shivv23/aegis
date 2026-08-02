import type { NextRequest } from "next/server";
import { authenticate, error, json } from "@/core/api";
import { getRail, listRails, railIsSimulated } from "@/core/rails";
import { getWallet } from "@/core/store";

export const runtime = "nodejs";

/**
 * Agent health check. Demonstrates that the agent can verify its own
 * scoped identity but can read nothing it should not. For owner keys it also
 * reports the settlement rail state so a judge can see exactly what is live
 * vs simulated.
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

  const active = getRail().id;
  return json({
    authenticated: true,
    scope: "owner",
    canDo: ["managePolicy", "freeze", "revoke", "viewAudit"],
    rails: {
      active,
      activeSimulated: railIsSimulated(active),
      note: railIsSimulated(active)
        ? "Active rail is simulated in-process. Set AEGIS_CIRCLE_API_KEY (USDC testnet) or AEGIS_RAIL to route through a live gateway."
        : "Active rail settles through a configured external gateway.",
      available: listRails().map(({ id, name, description }) => ({
        id,
        name,
        description,
        simulated: railIsSimulated(id),
      })),
    },
  });
}
