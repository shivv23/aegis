import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { parseSessionCookie, SESSION_COOKIE } from "@/core/auth";
import { revokeSession } from "@/core/store";

export const runtime = "nodejs";

/**
 * POST /api/auth/signout — revokes the current session and clears the cookie.
 */
export async function POST(req: NextRequest) {
  const sessionId = parseSessionCookie(req.headers.get("cookie"));
  if (sessionId) await revokeSession(sessionId);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
