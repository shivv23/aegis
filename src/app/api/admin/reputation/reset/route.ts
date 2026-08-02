import type { NextRequest } from "next/server";
import { z } from "zod";
import { authenticate, authorize, error, json } from "@/core/api";
import { addAudit, agentReputation, getWallet, resetWalletReputation } from "@/core/store";

export const runtime = "nodejs";

const bodySchema = z.object({
  walletId: z.string().min(1),
});

/**
 * POST /api/admin/reputation/reset  {walletId}
 *
 * Operator recovery for an agent whose reputation score is deadlocked below
 * the reliability floor (finding P1-2). Resets the scoring baseline so the
 * wallet re-earns trust on its next attempt instead of being permanently
 * blocked. Audit-stamped. In-memory reset window (same durability model as
 * the circuit breaker state) — enough for the demo's live org.
 */
export async function POST(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error("walletId is required", 400);

  const wallet = await getWallet(parsed.data.walletId);
  if (!wallet) return error("Wallet not found", 404);

  resetWalletReputation(wallet.id);
  const reputation = await agentReputation(wallet.id);

  await addAudit({
    walletId: wallet.id,
    actor: "owner",
    action: "REPUTATION_RESET",
    details: `Reputation scoring baseline reset by operator; score now ${reputation.score}/100`,
  });

  return json({ ok: true, walletId: wallet.id, reputation });
}
