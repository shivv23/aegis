import type { NextRequest } from "next/server";
import { authenticate, authorize, error, json } from "@/core/api";
import { getBreakerState, listWallets } from "@/core/store";

export const runtime = "nodejs";

/**
 * GET /api/breaker
 *
 * Owner view of the circuit breaker: threshold, window, and current anomaly
 * count per wallet. Also exposes the risk thresholds the rail applies.
 */
export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const wallets = await listWallets();
  const state = wallets.map((w) => ({
    walletId: w.id,
    ...getBreakerState(w.id),
  }));

  return json({ state });
}
