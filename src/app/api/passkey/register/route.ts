import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { randomBytes } from "node:crypto";
import { authenticate, authorize, error, json } from "@/core/api";
import {
  saveWebauthnChallenge,
  listWebauthnCredentials,
  saveWebauthnCredential,
} from "@/core/store";

export const runtime = "nodejs";

function rpConfig(req: NextRequest) {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "localhost:3000";
  const rpID = process.env.AEGIS_WEBAUTHN_RP_ID ?? host.split(":")[0];
  const origin =
    process.env.AEGIS_WEBAUTHN_ORIGIN ??
    `https://${host.split(":")[0]}${host.includes(":") ? "" : ""}`;
  return { rpID, origin };
}

const registerVerifySchema = z.object({
  name: z.string().min(1).max(60),
  credential: z.unknown(),
});

/**
 * POST /api/passkey/register — Step 1: mint a registration challenge.
 * Step 2 (same route, `verify: true` body flag): verify the authenticator's
 * attestation and store the credential. Real FIDO2 via @simplewebauthn.
 */
export async function POST(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const { rpID, origin } = rpConfig(req);
  const body = await req.json().catch(() => null);

  // ---- Step 2: verify attestation + persist credential -----------------
  if (body?.verify) {
    const parsed = registerVerifySchema.safeParse(body);
    if (!parsed.success) return error("Invalid credential payload", 400);

    const challenge = await consumeWebauthnChallengeFor(claims!.walletId, "register");
    if (!challenge) return error("Registration challenge expired or missing", 400);

    const verification = await verifyRegistrationResponse({
      response: parsed.data.credential as Parameters<typeof verifyRegistrationResponse>[0]["response"],
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });
    if (!verification.verified || !verification.registrationInfo) {
      return error("Authenticator verification failed", 400);
    }
    const { credential } = verification.registrationInfo;
    await saveWebauthnCredential({
      owner: claims!.walletId,
      name: parsed.data.name,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString("base64url"),
      counter: credential.counter,
    });
    return json(
      {
        verified: true,
        name: parsed.data.name,
        note: "Passkey registered. The next step-up can be approved with this authenticator.",
      },
      201,
    );
  }

  // ---- Step 1: issue registration options ------------------------------
  const existing = await listWebauthnCredentials(claims!.walletId);
  const options = await generateRegistrationOptions({
    rpName: "AEGIS",
    rpID,
    userName: claims!.walletId,
    userDisplayName: claims!.walletId,
    userID: Buffer.from(claims!.walletId),
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({
      id: c.credentialId,
      transports: (c.transports ?? []) as AuthenticatorTransport[],
    })),
    authenticatorSelection: { userVerification: "required" },
  });

  await saveWebauthnChallenge({
    challenge: options.challenge,
    owner: claims!.walletId,
    purpose: "register",
  });

  return json({ options, rpID, origin });
}

async function consumeWebauthnChallengeFor(owner: string, purpose: string): Promise<string | null> {
  const { consumeWebauthnChallenge, listWebauthnChallenges } = await import("@/core/store");
  const challenges = await listWebauthnChallenges(owner, purpose);
  if (challenges.length === 0) return null;
  const latest = challenges.sort((a, b) => b.createdAt - a.createdAt)[0];
  const used = await consumeWebauthnChallenge(latest.challenge, owner);
  return used ? latest.challenge : null;
}
