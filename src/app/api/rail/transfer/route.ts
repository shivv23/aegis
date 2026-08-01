import type { NextRequest } from "next/server";
import { z } from "zod";
import { authenticate, authorize, error, json } from "@/core/api";
import { runGuard, spendContext } from "@/core/guard";
import { HOLD_MS, addAudit, consumeNonce, createTransaction, getWallet, listTransactions, settleDue } from "@/core/store";

export const runtime = "nodejs";

const bodySchema = z.object({
  to: z.string().min(1),
  amount: z.number().positive().finite(),
  purpose: z.string().optional().default("agent-transfer"),
  nonce: z.string().min(1),
});

export async function POST(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "agent");
  if (!authz.ok) return error(authz.reason!, 401);

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error("Invalid transfer payload", 400);

  const { to, amount, purpose, nonce } = parsed.data;

  const wallet = await getWallet(claims!.walletId);
  if (!wallet) return error("Wallet not found", 404);

  if (!(await consumeNonce(nonce))) {
    return error("Replay detected: nonce already used", 409);
  }

  await settleDue();
  const context = spendContext(wallet.id, Date.now(), await listTransactions(wallet.id));

  const verdict = runGuard(wallet, amount, to, context);

  if (!verdict.allowed) {
    const tx = await createTransaction({
      walletId: wallet.id,
      from: wallet.id,
      to,
      amount,
      purpose,
      status: "BLOCKED",
      rejectionReason: verdict.reason,
      requestedAt: Date.now(),
      blockedAt: Date.now(),
      nonce,
    });
    await addAudit({
      walletId: wallet.id,
      actor: "agent",
      action: "TX_BLOCKED",
      details: `${amount} to ${to} blocked by guard: ${verdict.details}`,
    });
    return json(
      {
        status: "BLOCKED",
        reason: verdict.reason,
        details: verdict.details,
        transaction: tx,
      },
      403,
    );
  }

  const pendingUntil = Date.now() + HOLD_MS;
  const tx = await createTransaction({
    walletId: wallet.id,
    from: wallet.id,
    to,
    amount,
    purpose,
    status: "PENDING",
    requestedAt: Date.now(),
    pendingUntil,
    nonce,
  });
  await addAudit({
    walletId: wallet.id,
    actor: "agent",
    action: "TX_REQUESTED",
    details: `${amount} to ${to} requested, holding until settlement (in-flight window)`,
  });

  return json(
    {
      status: "PENDING",
      message: `Transfer in flight. Will settle in ${HOLD_MS}ms unless frozen or revoked.`,
      holdsForMs: HOLD_MS,
      transaction: tx,
    },
    201,
  );
}
