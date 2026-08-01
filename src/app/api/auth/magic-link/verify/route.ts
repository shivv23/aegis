import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { error, json } from "@/core/api";
import { parseSessionCookie, SESSION_COOKIE, verifyMagicToken } from "@/core/auth";
import { createSession } from "@/core/store";

export const runtime = "nodejs";

/**
 * GET /api/auth/magic-link/verify?token=
 * Exchanges a signed magic link for a session cookie, then redirects home.
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!token) return error("Missing token", 400);

  const email = await verifyMagicToken(token);
  if (!email) return error("Invalid or expired link", 401);

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    undefined;
  const userAgent = req.headers.get("user-agent") ?? undefined;

  const session = await createSession({ email, ip, userAgent });
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
