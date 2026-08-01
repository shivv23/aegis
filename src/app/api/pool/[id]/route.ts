import type { NextRequest } from "next/server";
import { authenticate, authorize, error, json } from "@/core/api";
import { deployPoolCoverage, getPool, poolRemaining } from "@/core/store";

export const runtime = "nodejs";

/**
 * Pool coverage operations (D6): deploy a loss-cap allocation to a pool,
 * or read a single pool's state.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const pool = await getPool(id);
  if (!pool) return error("Pool not found", 404);
  return json({ pool: { ...pool, remaining: poolRemaining(pool) } });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const body = (await req.json().catch(() => null)) as { amount?: number } | null;
  if (!body || typeof body.amount !== "number" || body.amount <= 0) {
    return error("amount (positive number) required", 400);
  }
  const pool = await deployPoolCoverage(id, body.amount);
  if (!pool) return error("Pool not found or coverage exceeds capacity", 409);
  return json({ pool: { ...pool, remaining: poolRemaining(pool) } });
}
