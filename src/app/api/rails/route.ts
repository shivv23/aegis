import type { NextRequest } from "next/server";
import { authenticate, authorize, error, json } from "@/core/api";
import { getRail, listRails } from "@/core/rails";
import { getWallet, setWalletPreferredRail } from "@/core/store";

export const runtime = "nodejs";

/**
 * GET   /api/rails
 * The settlement rails the guard can route money through, and the default
 * active rail (AEGIS_RAIL env).
 *
 * PATCH /api/rails  {walletId, rail}
 * Selects a wallet's preferred rail (A2). Every future settlement for that
 * wallet routes through it.
 */
export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  return json({
    active: getRail().id,
    rails: listRails().map(({ id, name, description }) => ({ id, name, description })),
  });
}

export async function PATCH(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const body = await req.json().catch(() => null);
  const walletId = typeof body?.walletId === "string" ? body.walletId : undefined;
  const rail = typeof body?.rail === "string" ? body.rail : undefined;
  if (!walletId || !rail) return error("walletId and rail are required", 400);

  if (!listRails().some((r) => r.id === rail)) {
    return error(`Unknown rail '${rail}'`, 400);
  }

  if (claims!.walletId !== "*" && claims!.walletId !== walletId) {
    return error("Key not authorized for this wallet", 403);
  }

  const wallet = await getWallet(walletId);
  if (!wallet) return error("Wallet not found", 404);

  const updated = await setWalletPreferredRail(walletId, rail);
  return json({ wallet: updated });
}
