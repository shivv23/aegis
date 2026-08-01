import type { NextRequest } from "next/server";
import { authenticate, authorizeOrg, error, json } from "@/core/api";
import { getOrgKillSwitch, setOrgKillSwitch } from "@/core/store";

export const runtime = "nodejs";

/**
 * Per-org kill switch (C7): an org owner freezes the org's entire wallet
 * fleet. Wallets in the org reject every transfer until it is lifted.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const claims = await authenticate(req);
  const authz = authorizeOrg(claims, id);
  if (!authz.ok) return error(authz.reason!, 401);

  const state = await getOrgKillSwitch(id);
  return json({ orgId: id, killSwitch: state ?? { enabled: false } });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const claims = await authenticate(req);
  const authz = authorizeOrg(claims, id);
  if (!authz.ok) return error(authz.reason!, 401);

  const body = (await req.json().catch(() => null)) as
    | { enabled?: boolean; reason?: string }
    | null;
  if (!body || typeof body.enabled !== "boolean") {
    return error("enabled (boolean) and reason (string) required", 400);
  }
  const reason = body.reason?.trim() || (body.enabled ? "Org kill switch" : "");
  const state = await setOrgKillSwitch(id, reason, body.enabled);
  return json({ orgId: id, killSwitch: state });
}
