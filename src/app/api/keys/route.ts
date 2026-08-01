import type { NextRequest } from "next/server";
import { authenticate, authorize, error, json } from "@/core/api";
import { agentKeyFor, masterOwnerKey, signKey } from "@/core/keys";
import { listAgentKeys } from "@/core/store";

export const runtime = "nodejs";

const OWNER = "owner";

export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const walletId = req.nextUrl.searchParams.get("walletId");
  if (!walletId) return error("walletId query param required", 400);

  return json({
    ownerKey: await masterOwnerKey(),
    walletOwnerKey: await signKey(walletId, OWNER),
    agentKey: await agentKeyFor(walletId),
    agentKeys: await listAgentKeys(walletId),
  });
}
