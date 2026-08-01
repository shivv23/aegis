import { SignJWT, jwtVerify } from "jose";
import type { Scope, ScopedKeyClaims } from "./types";

const secret = new TextEncoder().encode(
  process.env.AEGIS_SECRET ?? "aegis-dev-secret-change-me-in-production",
);

export const MASTER_WALLET_ID = "*";

export function signKey(walletId: string, scope: Scope, keyId?: string): Promise<string> {
  const claims: ScopedKeyClaims = {
    walletId,
    scope,
    role: scope === "owner" ? "wallet-owner" : "agent",
    ...(keyId ? { keyId } : {}),
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
