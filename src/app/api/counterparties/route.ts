import type { NextRequest } from "next/server";
import { z } from "zod";
import { authenticate, authorize, error, json } from "@/core/api";
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
  const authz = authorize(claims, "owner");
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

  const cp = await upsertCounterparty(parsed.data);
  return json({ counterparty: cp }, 201);
}
