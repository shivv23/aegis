import type { NextRequest } from "next/server";
import { authenticate, authorizeRead, error, json } from "@/core/api";
import { listSecurityEvents } from "@/core/store";

export const runtime = "nodejs";

/**
 * GET /api/security?limit=
 * SIEM-lite feed: the curated slice of the request audit that matters for
 * security — failed auth (invalid/revoked/unauthorized tokens) plus sensitive
 * actions (admin, freeze, policy, key and signer changes). Lets an operator
 * see the system watching itself.
 */
export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorizeRead(claims);
  if (!authz.ok) return error(authz.reason!, 401);

  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? 200), 500);
  const events = await listSecurityEvents(limit);
  return json({ events });
}
