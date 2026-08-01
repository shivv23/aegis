import type { NextRequest } from "next/server";
import { authenticate, authorizeOrg, error, json } from "@/core/api";
import { getOrg, listOrgWallets } from "@/core/store";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const claims = await authenticate(req);
  const authz = authorizeOrg(claims, id);
  if (!authz.ok) return error(authz.reason!, 401);

  const org = await getOrg(id);
  if (!org) return error("Organization not found", 404);

  const wallets = await listOrgWallets(id);
  return json({ org, wallets });
}
