/**
 * Magic-link authentication (1.1).
 *
 * Flow:
 *   1. /api/auth/magic-link/request  POST {email}  → signed one-time token
 *   2. /api/auth/magic-link/verify   GET  ?token=  → creates a session,
 *      sets an httpOnly cookie, redirects to /.
 *
 * Demo mode is untouched: the console still authenticates with a key via
 * /api/bootstrap. Sessions gate the *real-org* path and are revocable.
 *
 * Env knobs:
 *   AEGIS_MAGIC_TTL_MS     token lifetime            (default 10 min)
 *   AEGIS_RESEND_API_KEY   sends the link by email   (default: returned for dev)
 *   AEGIS_PUBLIC_URL       absolute link base        (default localhost:3000)
 */
import { SignJWT, jwtVerify } from "jose";
import type { AuthSession } from "./store";

export const MAGIC_ISSUER = "aegis-magic-link";
export const SESSION_COOKIE = "aegis_session";

export async function signMagicToken(email: string): Promise<string> {
  const secret = authSecret();
  return new SignJWT({ email: email.toLowerCase().trim() })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(MAGIC_ISSUER)
    .setAudience("aegis-auth")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(secret);
}

export async function verifyMagicToken(token: string): Promise<string | null> {
  try {
    const secret = authSecret();
    const { payload } = await jwtVerify(token, secret, {
      issuer: MAGIC_ISSUER,
      audience: "aegis-auth",
    });
    return typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}

export function publicBaseUrl(): string {
  return (process.env.AEGIS_PUBLIC_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

export function magicLinkFor(token: string): string {
  return `${publicBaseUrl()}/api/auth/magic-link/verify?token=${encodeURIComponent(token)}`;
}

/** True when we can actually email the link rather than echo it in dev. */
export function emailConfigured(): boolean {
  return Boolean(process.env.AEGIS_RESEND_API_KEY && process.env.AEGIS_EMAIL_FROM);
}

export function parseSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  return match ? decodeURIComponent(match.slice(SESSION_COOKIE.length + 1)) : null;
}

function authSecret(): Uint8Array {
  const raw = process.env.AEGIS_AUTH_SECRET;
  if (!raw) {
    throw new Error("AEGIS_AUTH_SECRET is not set");
  }
  return new TextEncoder().encode(raw);
}
