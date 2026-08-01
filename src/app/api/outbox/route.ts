import type { NextRequest } from "next/server";
import { authenticate, authorize, error, json } from "@/core/api";
import { listOutbox } from "@/core/store";

export const runtime = "nodejs";

/**
 * GET /api/outbox?walletId=
 * The ops alert feed — every guard decision and wallet event, newest first,
 * with delivery bookkeeping. Powers the Ops Center and future webhooks.
 */
export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const walletId = req.nextUrl.searchParams.get("walletId") ?? undefined;
  if (walletId && claims!.walletId !== "*" && claims!.walletId !== walletId) {
    return error("Key not authorized for this wallet", 403);
  }

  const alerts = await listOutbox(walletId);
  return json({ alerts });
}
