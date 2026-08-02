import type { NextRequest } from "next/server";
import { authenticate, authorizeRead, error, json } from "@/core/api";
import { listTransactionsPage, settleDue } from "@/core/store";
import { clampLimit, decodeCursor } from "@/core/pagination";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorizeRead(claims);
  if (!authz.ok) return error(authz.reason!, 401);

  const walletId = req.nextUrl.searchParams.get("walletId") ?? undefined;
  const limit = clampLimit(req.nextUrl.searchParams.get("limit"), 100, 1000);
  const cursor = decodeCursor(req.nextUrl.searchParams.get("cursor"));
  await settleDue();
  const { items, nextCursor } = await listTransactionsPage({ walletId, limit, cursor });
  return json({ transactions: items, nextCursor, limit });
}
