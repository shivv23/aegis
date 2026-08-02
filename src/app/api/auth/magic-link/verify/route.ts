import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { error } from "@/core/api";
import { parseSessionCookie, SESSION_COOKIE, verifyMagicTokenClaims } from "@/core/auth";
import { consumeMagicToken, createSession } from "@/core/store";

export const runtime = "nodejs";

/**
 * GET /api/auth/magic-link/verify?token=
 * Exchanges a signed magic link for a session cookie, then redirects home.
 * Each link is single-use (P2-2): replaying a captured token is rejected.
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!token) return error("Missing token", 400);

  const claims = await verifyMagicTokenClaims(token);
  if (!claims) return error("Invalid or expired link", 401);

  const consumed = await consumeMagicToken(claims.jti, claims.email);
  if (!consumed) return error("This link has already been used", 401);

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    undefined;
  const userAgent = req.headers.get("user-agent") ?? undefined;

  const session = await createSession({ email: claims.email, ip, userAgent });
  const res = NextResponse.redirect(new URL("/", req.url));
  res.cookies.set(SESSION_COOKIE, session.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
