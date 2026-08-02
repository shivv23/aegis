import type { NextRequest } from "next/server";
import { z } from "zod";
import { authenticate, authorize, error, json } from "@/core/api";
import { runTransfer } from "@/core/executor";
import { addAudit, listAgentKeys, touchAgentKey } from "@/core/store";
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
    const outcome = await runTransfer({
      walletId,
      to,
      amount,
      purpose,
      nonce,
      now,
      region: req.headers.get("x-aegis-region") ?? undefined,
      idempotencyKey,
    });
    return json(outcome.body, outcome.status);
  }

  // Path B — legacy scoped agent JWT (migration compatibility).
  const claims = await authenticate(req);
  const authz = authorize(claims, "agent");
  if (!authz.ok) return error(authz.reason!, 401);
  const outcome = await runTransfer({
    walletId: claims!.walletId,
    to,
    amount,
    purpose,
    nonce,
    now,
    region: req.headers.get("x-aegis-region") ?? undefined,
    idempotencyKey,
  });
  return json(outcome.body, outcome.status);
}
