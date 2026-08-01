import type { NextRequest } from "next/server";
import { z } from "zod";
import { authenticate, authorize, error, json } from "@/core/api";
import { runGuard, spendContext } from "@/core/guard";
import { HOLD_MS, addAudit, consumeNonce, createTransaction, getWallet, listAgentKeys, listTransactions, settleDue } from "@/core/store";
import { validateSignedTransfer } from "@/core/signing";

export const runtime = "nodejs";

const bodySchema = z.object({
  to: z.string().min(1),
  amount: z.number().positive().finite(),
  purpose: z.string().optional().default("agent-transfer"),
  nonce: z.string().min(1),
});

/**
 * POST /api/rail/transfer
 *
 * Agents authenticate either with an Ed25519-signed request (preferred) or
 * a legacy scoped JWT. The guard runs identically either way — enforcement
 * never depends on how the agent proved its identity.
 */
export async function POST(req: NextRequest) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error("Invalid transfer payload", 400);

  const { to, amount, purpose, nonce } = parsed.data;
  const now = Date.now();

  // Path A — Ed25519 signed request. The agent IS its keypair.
  const signature = req.headers.get("x-aegis-signature");
  const walletId = req.headers.get("x-aegis-wallet");
  if (signature && walletId) {
    const requestedAt = Number(req.headers.get("x-aegis-timestamp") ?? 0);
    if (!Number.isFinite(requestedAt)) {
      return error("x-aegis-timestamp header required", 400);
    }
    const agentKey = (await listAgentKeys(walletId)).find((k) => !k.revokedAt);
    if (!agentKey) return error("No active agent key for wallet", 401);

    const verdict = validateSignedTransfer(
      { walletId, to, amount, purpose, nonce, requestedAt },
      agentKey.publicKey,
      signature,
      now,
    );
    if (!verdict.ok) {
      await addAudit({
        walletId,
        actor: "agent",
        action: "SIGNATURE_REJECTED",
        details: `Signature validation failed: ${verdict.reason}`,
      });
      return error(
        verdict.reason === "REQUEST_EXPIRED" ? "Request expired" : "Invalid signature",
        401,
      );
    }
    return executeTransfer({ walletId, to, amount, purpose, nonce, now });
  }

  // Path B — legacy scoped agent JWT (migration compatibility).
  const claims = await authenticate(req);
  const authz = authorize(claims, "agent");
  if (!authz.ok) return error(authz.reason!, 401);
  return executeTransfer({
    walletId: claims!.walletId,
    to,
    amount,
    purpose,
    nonce,
    now,
  });
}

async function executeTransfer(input: {
  walletId: string;
  to: string;
  amount: number;
  purpose: string;
  nonce: string;
  now: number;
}) {
  const { walletId, to, amount, purpose, nonce, now } = input;

  if (!(await consumeNonce(nonce))) {
    return error("Replay detected: nonce already used", 409);
  }

  await settleDue();
  const wallet = await getWallet(walletId);
  if (!wallet) return error("Wallet not found", 404);
  const context = spendContext(wallet.id, now, await listTransactions(wallet.id));

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
      requestedAt: now,
      blockedAt: now,
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

  const pendingUntil = now + HOLD_MS;
  const tx = await createTransaction({
    walletId: wallet.id,
    from: wallet.id,
    to,
    amount,
    purpose,
    status: "PENDING",
    requestedAt: now,
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
