import type { NextRequest } from "next/server";
import { z } from "zod";
import { authenticate, authorize, error, json } from "@/core/api";
import { addAudit, registerAgentKey } from "@/core/store";
import { generateAgentKeyPair } from "@/core/signing";

export const runtime = "nodejs";

const mintSchema = z.object({
  walletId: z.string().min(1),
  label: z.string().optional().default("agent"),
});

/**
 * POST /api/keys/mint
 * Owner mints an Ed25519 agent keypair for a wallet. The private key is
 * returned exactly once; only the public key is stored. The agent signs
 * every transfer request with the private key.
 */
export async function POST(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const parsed = mintSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error("Invalid mint payload", 400);

  const { walletId, label } = parsed.data;
  if (claims!.walletId !== "*" && claims!.walletId !== walletId) {
    return error("Key not authorized for this wallet", 403);
  }

  const pair = generateAgentKeyPair();
  await registerAgentKey(walletId, pair.publicKey, label);
  await addAudit({
    walletId,
    actor: "owner",
    action: "AGENT_KEY_MINTED",
    details: `Agent keypair '${label}' minted (public ${pair.publicKey.slice(0, 12)}…)`,
  });

  return json(
    {
      walletId,
      label,
      publicKey: pair.publicKey,
      privateKey: pair.privateKey,
      warning: "Store the private key securely. It is shown only once.",
    },
    201,
  );
}
