import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { parseSessionCookie, SESSION_COOKIE } from "@/core/auth";
import { revokeApiKeyByHash, revokeSession } from "@/core/store";

export const runtime = "nodejs";

/**
 * POST /api/auth/signout  {key?}
 *
 * Revokes the current session, and — when the caller hands back the console's
 * owner key — revokes that key too, so a sign-out actually kills the
 * credential instead of leaving it valid until its 365-day expiry (P2-2).
 */
export async function POST(req: NextRequest) {
  const sessionId = parseSessionCookie(req.headers.get("cookie"));
  if (sessionId) await revokeSession(sessionId);

  const body = await req.json().catch(() => null);
  const key = typeof body?.key === "string" && body.key ? body.key : null;
  if (key) {
    const keyHash = createHash("sha256").update(key).digest("hex");
    await revokeApiKeyByHash(keyHash, "owner");
  }

  const res = NextResponse.json({ ok: true, keyRevoked: Boolean(key) });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
