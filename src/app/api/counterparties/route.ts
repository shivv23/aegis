import type { NextRequest } from "next/server";
import { z } from "zod";
import { authenticate, authorize, authorizeRead, error, json } from "@/core/api";
import { screenCounterparty } from "@/core/sanctions";
import { listCounterparties, upsertCounterparty } from "@/core/store";

export const runtime = "nodejs";

const bodySchema = z.object({
  name: z.string().min(1),
  address: z.string().min(1),
  status: z.enum(["ACTIVE", "FLAGGED", "BLOCKED"]).optional(),
  flags: z.array(z.string()).optional(),
  orgId: z.string().optional(),
});

export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorizeRead(claims);
  if (!authz.ok) return error(authz.reason!, 401);
  const orgId = req.nextUrl.searchParams.get("orgId") ?? undefined;
  return json({ counterparties: await listCounterparties(orgId) });
}

export async function POST(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error("Invalid counterparty payload", 400);

  // OFAC-lite: a watchlist hit at registration is auto-blocked and stamped —
  // the registry never stores a sanctioned payee as clean.
  const match = screenCounterparty({ name: parsed.data.name, address: parsed.data.address });
  const status = match ? ("BLOCKED" as const) : parsed.data.status;
  const flags = match
    ? [...(parsed.data.flags ?? []), `sanctioned:${match.entry.name}`]
    : parsed.data.flags;

  const cp = await upsertCounterparty({ ...parsed.data, status, flags });
  return json({ counterparty: cp, sanctions: match }, match ? 422 : 201);
}
