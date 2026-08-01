import type { NextRequest } from "next/server";
import { authenticate, authorize, error, json } from "@/core/api";
import { listOutboxPage } from "@/core/store";
import { clampLimit, decodeCursor } from "@/core/pagination";

export const runtime = "nodejs";

/**
 * GET /api/outbox?walletId=&cursor=&limit=
 * The ops alert feed — every guard decision and wallet event, newest first,
 * cursor-paginated, with delivery bookkeeping. Powers the Ops Center.
 */
export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const walletId = req.nextUrl.searchParams.get("walletId") ?? undefined;
  if (walletId && claims!.walletId !== "*" && claims!.walletId !== walletId) {
    return error("Key not authorized for this wallet", 403);
  }
  const limit = clampLimit(req.nextUrl.searchParams.get("limit"), 100, 1000);
  const cursor = decodeCursor(req.nextUrl.searchParams.get("cursor"));

  const { items, nextCursor } = await listOutboxPage({ walletId, limit, cursor });
  return json({ alerts: items, nextCursor, limit });
}
