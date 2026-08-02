import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { authenticate, authorize, error, json } from "@/core/api";
import {
  addAudit,
  approveStepUp,
  expireStepUps,
  getTransaction,
  getWebauthnCredential,
  saveWebauthnChallenge,
  updateWebauthnCounter,
} from "@/core/store";

export const runtime = "nodejs";

function rpConfig(req: NextRequest) {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "localhost:3000";
  const rpID = process.env.AEGIS_WEBAUTHN_RP_ID ?? host.split(":")[0];
  const origin =
    process.env.AEGIS_WEBAUTHN_ORIGIN ?? `https://${host.split(":")[0]}`;
  return { rpID, origin };
}

const assertVerifySchema = z.object({
  txId: z.string().min(1),
  credential: z.unknown(),
});

/**
 * POST /api/passkey/assert
 *  body { txId }                  → Step 1: mint an assertion challenge bound to the step-up.
 *  body { txId, credential }      → Step 2: verify authenticator signature; on success the
 *                                   step-up transfer is approved (physical presence, no bearer token).
 */
export async function POST(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const { rpID, origin } = rpConfig(req);
  const body = await req.json().catch(() => null);

  if (body?.credential) {
    const parsed = assertVerifySchema.safeParse(body);
    if (!parsed.success) return error("Invalid assertion payload", 400);

    await expireStepUps();
    const tx = await getTransaction(parsed.data.txId);
    if (!tx) return error("Transaction not found", 404);
    if (tx.status !== "STEP_UP_REQUIRED") {
      return error(`Transaction is not awaiting step-up (state '${tx.status}')`, 409);
    }

    const credentialId = String(
      (parsed.data.credential as { id?: unknown }).id ?? "",
    );
    const stored = await getWebauthnCredential(credentialId);
    if (!stored) return error("Unknown authenticator", 400);
    if (stored.owner !== tx.walletId && stored.owner !== "*") {
      return error("Authenticator not bound to this wallet", 403);
    }

    const challenge = await consumeChallengeFor(tx.walletId, parsed.data.txId);
    if (!challenge) return error("Assertion challenge expired or missing", 400);

    const verification = await verifyAuthenticationResponse({
      response: parsed.data.credential as Parameters<typeof verifyAuthenticationResponse>[0]["response"],
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: stored.credentialId,
        publicKey: Buffer.from(stored.publicKey, "base64url"),
        counter: stored.counter,
        transports: (stored.transports ?? []) as AuthenticatorTransport[],
      },
    });
    if (!verification.verified) return error("Authenticator signature invalid", 400);

    await updateWebauthnCounter(stored.credentialId, verification.authenticationInfo.newCounter);
    const result = await approveStepUp(tx.id);
    if (!result) return error("Step-up approval failed", 409);
    await addAudit({
      walletId: tx.walletId,
      actor: "owner",
      action: "STEP_UP_PASSKEY",
      details: `Step-up approved with hardware authenticator '${stored.name}' (counter ${verification.authenticationInfo.newCounter})`,
    });

    return json({
      verified: true,
      status: result.tx.status,
      authenticator: stored.name,
      message: "Step-up approved by hardware key. Transfer enters the holding window.",
      transaction: result.tx,
    });
  }

  // ---- Step 1: assertion options bound to the step-up ------------------
  const txId = String(body?.txId ?? "");
  if (!txId) return error("txId required", 400);
  await expireStepUps();
  const tx = await getTransaction(txId);
  if (!tx) return error("Transaction not found", 404);
  if (tx.status !== "STEP_UP_REQUIRED") {
    return error(`Transaction is not awaiting step-up (state '${tx.status}')`, 409);
  }

  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "required",
  });
  await saveWebauthnChallenge({
    challenge: options.challenge,
    owner: tx.walletId,
    purpose: "stepup",
    txId,
  });
  return json({ options, rpID, origin, txId });
}

async function consumeChallengeFor(owner: string, txId: string): Promise<string | null> {
  const { consumeWebauthnChallenge, listWebauthnChallenges } = await import("@/core/store");
  const challenges = await listWebauthnChallenges(owner, "stepup");
  const match = challenges
    .filter((c) => c.txId === txId)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!match) return null;
  return (await consumeWebauthnChallenge(match.challenge, owner)) ? match.challenge : null;
}
