import type { NextRequest } from "next/server";
import { authenticate, authorize, error, json } from "@/core/api";
import { listUsagePage } from "@/core/store";
import { clampLimit, decodeCursor } from "@/core/pagination";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);
  const walletId = req.nextUrl.searchParams.get("walletId") ?? undefined;
  const limit = clampLimit(req.nextUrl.searchParams.get("limit"), 100, 1000);
  const cursor = decodeCursor(req.nextUrl.searchParams.get("cursor"));

  const { items, nextCursor } = await listUsagePage({ walletId, limit, cursor });
  const usage = items;

  const totals = usage.reduce(
    (acc, u) => {
      acc.totalTxs += 1;
      acc.totalUsd += u.amount;
      acc.byRail[u.rail] = (acc.byRail[u.rail] ?? 0) + u.amount;
      return acc;
    },
    { totalTxs: 0, totalUsd: 0, byRail: {} as Record<string, number> },
  );

  return json({ usage, totals, nextCursor, limit });
}
