import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { verifyKey } from "./keys";
import { isApiKeyRevoked } from "./store";
import type { Scope, ScopedKeyClaims } from "./types";
export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export function error(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Verifies the bearer token from the Authorization header and returns the
 * scoped claims, or null if the token is missing/invalid. Every attempt is
 * written to the request audit (B4) — fire-and-forget so auth never blocks.
 */
export async function authenticate(
  req: NextRequest,
): Promise<ScopedKeyClaims | null> {
  const header = req.headers.get("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
  const claims = token ? await verifyKey(token) : null;
  const keyHash = token
    ? createHash("sha256").update(token).digest("hex")
    : undefined;
  // A revoked key (e.g. after sign-out) is rejected even though its JWT is
  // still cryptographically valid (P2-2).
  const revoked = keyHash && claims ? await isApiKeyRevoked(keyHash) : false;
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    undefined;
  const userAgent = req.headers.get("user-agent") ?? undefined;

  const audit = {
    method: req.method,
    path: req.nextUrl.pathname,
    keyHash,
    scope: claims?.scope,
    walletId: claims?.walletId,
    ip,
    userAgent,
    result: revoked
      ? "REVOKED"
      : claims
        ? "OK"
        : header
          ? "INVALID"
          : "UNAUTHORIZED",
  };
  if (process.env.AEGIS_REQUEST_AUDIT !== "0") {
    import("./store")
      .then((m) => m.recordRequestAudit(audit))
      .catch(() => {});
  }
  return revoked ? null : claims;
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

/**
 * Authorizes a read-only accessor (owner or auditor). Auditor keys are the
 * read-only reviewer role: they may inspect the ledger, audit, outbox,
 * exports and guardian — but every mutating route keeps requiring `owner`,
 * so an auditor can never freeze, revoke, or edit policy.
 */
export function authorizeRead(
  claims: ScopedKeyClaims | null,
  walletId?: string,
): { ok: boolean; reason?: string } {
  if (!claims) {
    return { ok: false, reason: "Missing or invalid credentials" };
  }
  if (claims.scope !== "owner" && claims.scope !== "auditor") {
    return {
      ok: false,
      reason: `Key has scope '${claims.scope}', requires 'owner' or 'auditor'`,
    };
  }
  if (walletId && claims.walletId !== walletId && claims.walletId !== "*") {
    return { ok: false, reason: "Key is not authorized for this wallet" };
  }
  return { ok: true };
}

/**
 * Authorizes an owner key against an organization. The master key ("*", no
 * org) may manage any org; an org-scoped owner key may only manage wallets
 * inside its own org.
 */
export function authorizeOrg(
  claims: ScopedKeyClaims | null,
  orgId: string,
): { ok: boolean; reason?: string } {
  if (!claims) {
    return { ok: false, reason: "Missing or invalid credentials" };
  }
  if (claims.scope !== "owner") {
    return { ok: false, reason: `Key has scope '${claims.scope}', requires 'owner'` };
  }
  if (claims.orgId && claims.orgId !== orgId) {
    return { ok: false, reason: "Key is not authorized for this org" };
  }
  return { ok: true };
}

/**
 * An org-scoped owner key may only touch wallets that belong to its org.
 */
export function authorizeWalletOrg(
  claims: ScopedKeyClaims | null,
  walletOrgId: string | undefined,
): { ok: boolean; reason?: string } {
  if (claims?.orgId && claims.orgId !== walletOrgId) {
    return { ok: false, reason: "Key is not authorized for this wallet's org" };
  }
  return { ok: true };
}
