import type { NextRequest } from "next/server";
import { authenticate, authorize, error, json } from "@/core/api";
import { createPool, listPools, poolRemaining } from "@/core/store";

export const runtime = "nodejs";

/**
 * Guarantee/insurance pool (D6): a configurable loss-sharing cap per wallet.
 * The pool backstops counterparties against agent defaults — the trust
 * product that unlocks real money for agents.
 */
export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const orgId = req.nextUrl.searchParams.get("orgId") ?? undefined;
  const pools = await listPools(orgId);
  return json({ pools: pools.map((p) => ({ ...p, remaining: poolRemaining(p) })) });
}

export async function POST(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const body = (await req.json().catch(() => null)) as
    | { name?: string; orgId?: string; capacity?: number; lossCap?: number }
    | null;
  if (!body || !body.name || typeof body.capacity !== "number" || typeof body.lossCap !== "number") {
    return error("name (string), capacity (number), lossCap (number) required", 400);
  }
  if (body.capacity <= 0 || body.lossCap <= 0) {
    return error("capacity and lossCap must be positive", 400);
  }
  if (body.orgId && claims!.orgId && claims!.orgId !== body.orgId) {
    return error("Key is not authorized for this org", 401);
  }
  const pool = await createPool({
    name: body.name,
    orgId: body.orgId ?? claims!.orgId,
    capacity: body.capacity,
    lossCap: body.lossCap,
  });
  return json({ pool }, 201);
}
