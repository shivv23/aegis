import type { NextRequest } from "next/server";
import { authenticate, authorize, error, json } from "@/core/api";
import { getRail, listRails } from "@/core/rails";

export const runtime = "nodejs";

/**
 * GET /api/rails
 *
 * The settlement rails the guard can route money through, and which one is
 * currently active (AEGIS_RAIL).
 */
export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  return json({
    active: getRail().id,
    rails: listRails().map(({ id, name, description }) => ({ id, name, description })),
  });
}
