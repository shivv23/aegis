import type { NextRequest } from "next/server";
import { z } from "zod";
import { authenticate, authorize, error, json } from "@/core/api";
import { createRecurringSchedule, listRecurringSchedules } from "@/core/store";

export const runtime = "nodejs";

const bodySchema = z.object({
  walletId: z.string().min(1),
  to: z.string().min(1),
  amount: z.number().positive().finite(),
  purpose: z.string().optional().default("recurring"),
  everyHours: z.number().positive().max(24 * 30),
  dailyHour: z.number().int().min(0).max(23).optional(),
});

/**
 * Recurring transfers (cron-lite). Each due run is re-evaluated by the guard
 * at execution time — a policy tightened yesterday blocks today's run.
 */
export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const walletId = req.nextUrl.searchParams.get("walletId") ?? undefined;
  if (walletId && claims!.walletId !== "*" && claims!.walletId !== walletId) {
    return error("Key not authorized for this wallet", 403);
  }
  return json({ schedules: await listRecurringSchedules(walletId) });
}

export async function POST(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error("Invalid schedule payload", 400);

  if (claims!.walletId !== "*" && claims!.walletId !== parsed.data.walletId) {
    return error("Key not authorized for this wallet", 403);
  }

  const schedule = await createRecurringSchedule(parsed.data);
  return json({ schedule }, 201);
}
