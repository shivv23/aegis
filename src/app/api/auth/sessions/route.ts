import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { error, json } from "@/core/api";
import { parseSessionCookie, SESSION_COOKIE } from "@/core/auth";
import { getSession, listSessions, revokeSession, touchSession } from "@/core/store";

export const runtime = "nodejs";

/**
 * GET  /api/auth/session        current session (from cookie)
 * GET  /api/auth/sessions       all sessions for this account
 * POST /api/auth/sessions       {id} revoke a session (current is disallowed)
 */
export async function GET(req: NextRequest) {
  const sessionId = parseSessionCookie(req.headers.get("cookie"));
  const path = req.nextUrl.pathname;

  if (path.endsWith("/sessions")) {
    const session = sessionId ? await getSession(sessionId) : null;
    if (!session || session.revokedAt) return error("No active session", 401);
    await touchSession(session.id);
    const sessions = await listSessions(session.email);
    return json({ sessions });
  }

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

export async function POST(req: NextRequest) {
  const sessionId = parseSessionCookie(req.headers.get("cookie"));
  const session = sessionId ? await getSession(sessionId) : null;
  if (!session || session.revokedAt) return error("No active session", 401);

  const body = await req.json().catch(() => ({}));
  const targetId = typeof body.id === "string" ? body.id : undefined;
  if (!targetId) return error("id is required", 400);
  if (targetId === sessionId) return error("Revoke from a different session", 400);

  const ok = await revokeSession(targetId);
  return json({ ok });
}

export async function DELETE(req: NextRequest) {
  const sessionId = parseSessionCookie(req.headers.get("cookie"));
  const session = sessionId ? await getSession(sessionId) : null;
  if (!session || session.revokedAt) return error("No active session", 401);

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return error("id query param is required", 400);

  const ok = await revokeSession(id);
  return json({ ok });
}
