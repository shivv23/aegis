import type { NextRequest } from "next/server";
import { z } from "zod";
import { authenticate, authorize, error, json } from "@/core/api";
import { revokeAgentKey } from "@/core/store";
import { addAudit } from "@/core/store";

export const runtime = "nodejs";

const bodySchema = z.object({
  walletId: z.string().min(1),
  publicKey: z.string().min(1),
});

export async function POST(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error("walletId and publicKey required", 400);

  await revokeAgentKey(parsed.data.walletId, parsed.data.publicKey);
  await addAudit({
    walletId: parsed.data.walletId,
    actor: "owner",
    action: "AGENT_KEY_REVOKED",
    details: `Agent key ${parsed.data.publicKey.slice(0, 12)}… revoked`,
  });
  return json({ ok: true });
}
