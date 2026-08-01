import type { NextRequest } from "next/server";
import { json } from "@/core/api";
import { parseSessionCookie } from "@/core/auth";
import { getSession, touchSession } from "@/core/store";

export const runtime = "nodejs";

/**
 * GET /api/auth/session — the current session, read from the cookie.
 * Returns { session: null } when signed out so the client can branch on it.
 */
export async function GET(req: NextRequest) {
  const sessionId = parseSessionCookie(req.headers.get("cookie"));
  const session = sessionId ? await getSession(sessionId) : null;
  if (!session || session.revokedAt) return json({ session: null });

  await touchSession(session.id);
  return json({
    session: {
      id: session.id,
      email: session.email,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      ip: session.ip,
      userAgent: session.userAgent,
    },
  });
}
