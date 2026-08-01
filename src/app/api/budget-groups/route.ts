import type { NextRequest } from "next/server";
import { z } from "zod";
import { authenticate, authorize, error, json } from "@/core/api";
import { createBudgetGroup, groupSpendLast30d, listBudgetGroups, getBudgetGroupForWallet } from "@/core/store";

export const runtime = "nodejs";

const bodySchema = z.object({
  name: z.string().min(1),
  monthlyLimit: z.number().positive().finite(),
  orgId: z.string().optional(),
  walletIds: z.array(z.string()).optional(),
});

export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);
  const walletId = req.nextUrl.searchParams.get("walletId");
  if (walletId) {
    const group = await getBudgetGroupForWallet(walletId);
    return json({ group: group ? { ...group, spentLast30d: await groupSpendLast30d(group) } : null });
  }
  const orgId = req.nextUrl.searchParams.get("orgId") ?? undefined;
  const groups = await listBudgetGroups(orgId);
  const withSpend = await Promise.all(
    groups.map(async (g) => ({ ...g, spentLast30d: await groupSpendLast30d(g) })),
  );
  return json({ groups: withSpend });
}

export async function POST(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error("Invalid budget group payload", 400);

  const group = await createBudgetGroup(parsed.data);
  return json({ group }, 201);
}
