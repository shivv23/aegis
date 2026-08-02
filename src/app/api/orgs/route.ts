import type { NextRequest } from "next/server";
import { z } from "zod";
import { authenticate, authorize, error, json } from "@/core/api";
import { createOrg, listOrgs } from "@/core/store";
import { signKey } from "@/core/keys";

export const runtime = "nodejs";

/**
 * GET /api/orgs — list organizations visible to this owner key.
 * POST /api/orgs — create an organization (master key). Returns an
 * org-scoped owner key that can only manage wallets inside this org.
 */
export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const orgs = await listOrgs();
  const visible = claims?.orgId ? orgs.filter((o) => o.id === claims.orgId) : orgs;
  return json({ orgs: visible });
}

const bodySchema = z.object({ name: z.string().min(1) });

export async function POST(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);
  if (claims?.orgId) return error("Org-scoped keys cannot create organizations", 403);

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error("Invalid org payload", 400);

  const org = await createOrg(parsed.data.name);
  return json(
    {
      org,
      orgOwnerKey: await signKey("*", "owner", { orgId: org.id }),
      note: "orgOwnerKey can only manage wallets inside this organization.",
    },
    201,
  );
}
