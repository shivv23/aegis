import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { verifyKey } from "./keys";
import type { Scope, ScopedKeyClaims } from "./types";
export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export function error(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Verifies the bearer token from the Authorization header and returns the
 * scoped claims, or null if the token is missing/invalid.
 */
export async function authenticate(
  req: NextRequest,
): Promise<ScopedKeyClaims | null> {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return verifyKey(header.slice(7).trim());
}

/**
 * Authorizes a request against a required scope. Agent keys are scoped to a
 * single wallet and may only ever reach the rail endpoints. Owner keys may
 * either be the master key ("*") or a per-wallet owner key.
 */
export function authorize(
  claims: ScopedKeyClaims | null,
  required: Scope,
  walletId?: string,
): { ok: boolean; reason?: string } {
  if (!claims) {
    return { ok: false, reason: "Missing or invalid credentials" };
  }
  if (claims.scope !== required) {
    return {
      ok: false,
      reason: `Key has scope '${claims.scope}', requires '${required}'`,
    };
  }
  if (walletId && claims.walletId !== walletId && claims.walletId !== "*") {
    return { ok: false, reason: "Key is not authorized for this wallet" };
  }
  return { ok: true };
}
