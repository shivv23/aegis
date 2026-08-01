import type { NextRequest } from "next/server";
import { authenticate, authorize, error, json } from "@/core/api";
import { listTransactions, settleDue } from "@/core/store";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const walletId = req.nextUrl.searchParams.get("walletId") ?? undefined;
  await settleDue();
  const transactions = await listTransactions(walletId);
  return json({ transactions });
}
