import { SignJWT, jwtVerify } from "jose";
import type { Scope, ScopedKeyClaims } from "./types";

const secret = new TextEncoder().encode(
  process.env.AEGIS_SECRET ?? "aegis-dev-secret-change-me-in-production",
);

export const MASTER_WALLET_ID = "*";

export function signKey(walletId: string, scope: Scope, keyId?: string, orgId?: string): Promise<string> {
  const claims: ScopedKeyClaims = {
    walletId,
    scope,
    role: scope === "owner" ? "wallet-owner" : "agent",
    ...(keyId ? { keyId } : {}),
    ...(orgId ? { orgId } : {}),
  };
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("aegis")
    .setExpirationTime("365d")
    .sign(secret);
}

export async function verifyKey(
  token: string | undefined | null,
): Promise<ScopedKeyClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: "aegis",
      algorithms: ["HS256"],
    });
    if (
      typeof payload.walletId === "string" &&
      (payload.scope === "agent" || payload.scope === "owner")
    ) {
      return {
        walletId: payload.walletId,
        scope: payload.scope,
        role: payload.role as string,
        ...(typeof payload.keyId === "string" ? { keyId: payload.keyId } : {}),
        ...(typeof payload.orgId === "string" ? { orgId: payload.orgId } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function masterOwnerKey(): Promise<string> {
  return signKey(MASTER_WALLET_ID, "owner");
}

export function agentKeyFor(walletId: string): Promise<string> {
  return signKey(walletId, "agent");
}

/**
 * One-tap decision tokens for email/Slack deep links. A short-lived JWT bound
 * to a single (wallet, transaction, action) triple — the bearer can approve or
 * decline that exact step-up and nothing else. Separate issuer so it can never
 * be confused with an owner key.
 */
export interface DecisionTokenClaims {
  walletId: string;
  txId: string;
  action: "approve" | "decline";
}

export async function signDecisionToken(
  walletId: string,
  txId: string,
  action: "approve" | "decline",
  ttlMs = 15 * 60 * 1000,
): Promise<string> {
  return new SignJWT({ scope: "decision", walletId, txId, action })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("aegis-decision")
    .setExpirationTime(`${Math.floor(ttlMs / 1000)}s`)
    .sign(secret);
}

export async function verifyDecisionToken(
  token: string | undefined | null,
): Promise<DecisionTokenClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: "aegis-decision",
      algorithms: ["HS256"],
    });
    if (
      payload.scope === "decision" &&
      typeof payload.walletId === "string" &&
      typeof payload.txId === "string" &&
      (payload.action === "approve" || payload.action === "decline")
    ) {
      return {
        walletId: payload.walletId,
        txId: payload.txId,
        action: payload.action,
      };
    }
    return null;
  } catch {
    return null;
  }
}
