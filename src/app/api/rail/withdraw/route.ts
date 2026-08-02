import type { NextRequest } from "next/server";
import { z } from "zod";
import { authenticate, authorize, error, json } from "@/core/api";
import { runWithdrawal } from "@/core/executor";

export const runtime = "nodejs";

const bodySchema = z.object({
  walletId: z.string().min(1),
  amount: z.number().positive().finite(),
  destination: z.string().min(1),
  idempotencyKey: z.string().min(1).optional(),
});

/**
 * POST /api/rail/withdraw — simulated withdrawal lifecycle.
 * Freeze + funds checks only; labeled simulated.
 */
export async function POST(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error("Invalid withdrawal payload", 400);

  if (claims!.walletId !== "*" && claims!.walletId !== parsed.data.walletId) {
    return error("Key not authorized for this wallet", 403);
  }

  const outcome = await runWithdrawal({
    walletId: parsed.data.walletId,
    amount: parsed.data.amount,
    destination: parsed.data.destination,
    idempotencyKey: parsed.data.idempotencyKey,
  });
  return json(outcome.body, outcome.status);
}
