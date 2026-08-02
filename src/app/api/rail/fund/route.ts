import type { NextRequest } from "next/server";
import { z } from "zod";
import { authenticate, authorize, error, json } from "@/core/api";
import { runDeposit } from "@/core/executor";

export const runtime = "nodejs";

const bodySchema = z.object({
  walletId: z.string().min(1),
  amount: z.number().positive().finite(),
  method: z.enum(["wire", "ach", "card"]).optional().default("wire"),
  idempotencyKey: z.string().min(1).optional(),
});

/**
 * POST /api/rail/fund — simulated funding/deposit lifecycle.
 * No real money moves; every deposit is labeled simulated.
 */
export async function POST(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error("Invalid funding payload", 400);

  if (claims!.walletId !== "*" && claims!.walletId !== parsed.data.walletId) {
    return error("Key not authorized for this wallet", 403);
  }

  const outcome = await runDeposit({
    walletId: parsed.data.walletId,
    amount: parsed.data.amount,
    method: parsed.data.method,
    idempotencyKey: parsed.data.idempotencyKey,
  });
  return json(outcome.body, outcome.status);
}
