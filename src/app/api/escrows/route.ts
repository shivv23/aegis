import type { NextRequest } from "next/server";
import { z } from "zod";
import { authenticate, authorize, error, json } from "@/core/api";
import { createEscrow, listEscrows, releaseEscrow, refundEscrow } from "@/core/store";

export const runtime = "nodejs";

const bodySchema = z.object({
  walletId: z.string().min(1),
  to: z.string().min(1),
  amount: z.number().positive().finite(),
  condition: z.string().min(1),
  heldUntil: z.number().optional(),
});

export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);
  const walletId = req.nextUrl.searchParams.get("walletId") ?? undefined;
  return json({ escrows: await listEscrows(walletId) });
}

export async function POST(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error("Invalid escrow payload", 400);

  const escrow = await createEscrow(parsed.data);
  return json({ escrow }, 201);
}

export async function PATCH(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return error("id query param required", 400);
  const action = req.nextUrl.searchParams.get("action");
  if (action !== "release" && action !== "refund") {
    return error("action must be 'release' or 'refund'", 400);
  }

  const escrow = action === "release" ? await releaseEscrow(id) : await refundEscrow(id);
  if (!escrow) return error("Escrow not found", 404);
  return json({ escrow });
}
