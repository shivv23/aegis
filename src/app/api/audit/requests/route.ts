import type { NextRequest } from "next/server";
import { authenticate, authorize, error, json } from "@/core/api";
import { listRequestAudit, resetRequestAudit } from "@/core/store";

export const runtime = "nodejs";

/**
 * GET  /api/audit/requests?limit=200   full request audit (B4)
 * POST /api/audit/requests/reset       clear the log (owner only)
 */
export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 200);
  const entries = await listRequestAudit(Math.min(limit, 1000));
  return json({ entries });
}

export async function POST(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);
  await resetRequestAudit();
  return json({ ok: true });
}
