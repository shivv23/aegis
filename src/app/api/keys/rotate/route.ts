import type { NextRequest } from "next/server";
import { z } from "zod";
import { authenticate, authorize, error, json } from "@/core/api";
import { rotateAgentKey, addAudit } from "@/core/store";
import { generateAgentKeyPair } from "@/core/signing";

export const runtime = "nodejs";

const bodySchema = z.object({
  walletId: z.string().min(1),
  publicKey: z.string().min(1),
  label: z.string().min(1).optional(),
  expiresAt: z.number().optional(),
});

export async function POST(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error("walletId and publicKey required", 400);

  const pair = await generateAgentKeyPair();
  const record = await rotateAgentKey(
    parsed.data.walletId,
    parsed.data.publicKey,
    pair.publicKey,
    parsed.data.label ?? "rotated",
    { expiresAt: parsed.data.expiresAt },
  );
  await addAudit({
    walletId: parsed.data.walletId,
    actor: "owner",
    action: "AGENT_KEY_ROTATED",
    details: `Agent key ${parsed.data.publicKey.slice(0, 12)}… rotated to ${pair.publicKey.slice(0, 12)}…`,
  });
  return json({
    ok: true,
    record,
    // The new private key is handed to the agent only at rotation time.
    privateKey: pair.privateKey,
  });
}
