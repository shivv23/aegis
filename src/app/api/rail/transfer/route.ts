import type { NextRequest } from "next/server";
import { z } from "zod";
import { authenticate, authorize, error, json } from "@/core/api";
import { runGuard, spendContext } from "@/core/guard";
import { HOLD_MS, STEP_UP_TTL_MS, addAudit, consumeNonce, createTransaction, expireStepUps, findTransactionByIdempotencyKey, getBudgetGroupForWallet, getCounterparty, getWallet, groupSpendLast30d, listAgentKeys, listTransactions, recordAnomaly, recordOutbox, settleDue, touchAgentKey } from "@/core/store";
import { validateSignedTransfer } from "@/core/signing";
import { CRITICAL_THRESHOLD, scoreTransfer, STEP_UP_THRESHOLD } from "@/core/risk";
import { decisionLink } from "@/core/approval-links";

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
  const idempotencyKey =
    req.headers.get("idempotency-key") ?? req.headers.get("x-idempotency-key") ?? undefined;

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
    if (agentKey.expiresAt && agentKey.expiresAt < now) {
      return error("Agent key expired", 401);
    }
    await touchAgentKey(walletId, agentKey.publicKey);

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
    return executeTransfer({ walletId, to, amount, purpose, nonce, now, region: req.headers.get("x-aegis-region") ?? undefined, idempotencyKey });
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
    region: req.headers.get("x-aegis-region") ?? undefined,
    idempotencyKey,
  });
}

async function executeTransfer(input: {
  walletId: string;
  to: string;
  amount: number;
  purpose: string;
  nonce: string;
  now: number;
  region?: string;
  idempotencyKey?: string;
}) {
  const { walletId, to, amount, purpose, nonce, now, region, idempotencyKey } = input;

  // Idempotent retry: a replayed key returns the original result instead of
  // double-settling. Checked before nonce consumption so a retry does not
  // burn the nonce or create a second transaction.
  if (idempotencyKey) {
    const existing = await findTransactionByIdempotencyKey(idempotencyKey);
    if (existing) {
      return json({ status: existing.status, replayed: true, transaction: existing }, 200);
    }
  }

  if (!(await consumeNonce(nonce))) {
    return error("Replay detected: nonce already used", 409);
  }

  await settleDue();
  await expireStepUps(now);
  const wallet = await getWallet(walletId);
  if (!wallet) return error("Wallet not found", 404);
  const history = await listTransactions(wallet.id);
  const context = spendContext(wallet.id, now, history);

  // Counterparty reputation + budget group enforcement.
  const counterparty = await getCounterparty(to);
  const group = await getBudgetGroupForWallet(wallet.id);
  const groupSpent = group ? await groupSpendLast30d(group, now) : undefined;

  const verdict = runGuard(wallet, amount, to, { ...context, region, groupSpent }, {
    counterpartyStatus: counterparty?.status,
    groupLimit: group?.monthlyLimit,
  });

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
      idempotencyKey,
    });
    await recordAnomaly(wallet.id, "TX_BLOCKED", `${amount} to ${to} blocked: ${verdict.details}`);
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

  // Hard guard passed — now score the transfer for risk.
  const risk = scoreTransfer({
    wallet,
    amount,
    to,
    purpose,
    history,
    now,
  });

  if (risk.level === "CRITICAL") {
    const tx = await createTransaction({
      walletId: wallet.id,
      from: wallet.id,
      to,
      amount,
      purpose,
      status: "BLOCKED",
      rejectionReason: "RISK_REJECTED",
      requestedAt: now,
      blockedAt: now,
      nonce,
      idempotencyKey,
      stepUpScore: risk.score,
    });
    await recordAnomaly(wallet.id, "TX_BLOCKED_RISK", `Critical risk score ${risk.score} for ${amount} to ${to}`);
    return json(
      {
        status: "BLOCKED",
        reason: "RISK_REJECTED",
        details: `Critical risk score ${risk.score} (threshold ${CRITICAL_THRESHOLD})`,
        score: risk.score,
        factors: risk.factors,
        transaction: tx,
      },
      403,
    );
  }

  if (risk.level === "HIGH") {
    const stepUpUntil = now + STEP_UP_TTL_MS;
    const tx = await createTransaction({
      walletId: wallet.id,
      from: wallet.id,
      to,
      amount,
      purpose,
      status: "STEP_UP_REQUIRED",
      requestedAt: now,
      pendingUntil: stepUpUntil,
      nonce,
      idempotencyKey,
      stepUpScore: risk.score,
    });
    await addAudit({
      walletId: wallet.id,
      actor: "system",
      action: "STEP_UP_REQUIRED",
      details: `Risk score ${risk.score} (threshold ${STEP_UP_THRESHOLD}) — owner approval required for ${amount} to ${to}`,
    });
    await recordOutbox(wallet.id, "STEP_UP_REQUIRED", {
      txId: tx.id,
      amount,
      to,
      score: risk.score,
      factors: risk.factors,
      approveLink: await decisionLink(wallet.id, tx.id, "approve"),
      declineLink: await decisionLink(wallet.id, tx.id, "decline"),
    });
    return json(
      {
        status: "STEP_UP_REQUIRED",
        message: `Risk score ${risk.score} requires owner approval. Expires in ${STEP_UP_TTL_MS}ms.`,
        score: risk.score,
        threshold: STEP_UP_THRESHOLD,
        factors: risk.factors,
        expiresInMs: STEP_UP_TTL_MS,
        approveLink: await decisionLink(wallet.id, tx.id, "approve"),
        declineLink: await decisionLink(wallet.id, tx.id, "decline"),
        transaction: tx,
      },
      202,
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
    stepUpScore: risk.score,
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
      score: risk.score,
      transaction: tx,
    },
    201,
  );
}
