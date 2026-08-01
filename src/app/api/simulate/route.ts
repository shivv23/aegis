import type { NextRequest } from "next/server";
import { z } from "zod";
import { authenticate, authorize, error, json } from "@/core/api";
import { listTransactions } from "@/core/store";
import { simulatePolicy } from "@/core/simulate";
import type { WalletPolicy } from "@/core/types";

export const runtime = "nodejs";

const policySchema = z.object({
  maxPerTx: z.number().positive(),
  dailyLimit: z.number().positive(),
  monthlyLimit: z.number().positive(),
  velocityLimitPerMin: z.number().int().positive(),
  allowlist: z.array(z.string()),
});

const bodySchema = z.object({
  walletId: z.string().min(1),
  policy: policySchema,
});

/**
 * POST /api/simulate
 *
 * What-if policy simulator. Replays a wallet's real transaction history
 * against a hypothetical policy and reports every would-be verdict. Purely
 * read-only — nothing is written to the ledger.
 */
export async function POST(req: NextRequest) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error("Invalid simulation payload", 400);

  const claims = await authenticate(req);
  const authz = authorize(claims, "owner", parsed.data.walletId);
  if (!authz.ok) return error(authz.reason!, 401);

  const history = await listTransactions(parsed.data.walletId);
  if (history.length === 0) {
    return error("Wallet has no transaction history to replay", 404);
  }

  const policy: WalletPolicy = parsed.data.policy;
  const result = simulatePolicy(policy, history);
  return json(result);
}
