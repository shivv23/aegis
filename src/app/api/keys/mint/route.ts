import type { NextRequest } from "next/server";
import { z } from "zod";
import { authenticate, authorize, error, json } from "@/core/api";
import { addAudit, putSecret, registerAgentKey } from "@/core/store";
import { generateAgentKeyPair } from "@/core/signing";
import { secretsEnabled } from "@/core/secrets";

export const runtime = "nodejs";

const mintSchema = z.object({
  walletId: z.string().min(1),
  label: z.string().optional().default("agent"),
});

/**
 * POST /api/keys/mint
 * Owner mints an Ed25519 agent keypair for a wallet. The private key is
 * returned exactly once. When a KMS master key is configured the private key
 * is also persisted envelope-encrypted (recoverable); otherwise only the
 * public key is stored.
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
  const stored = await putSecret(walletId, "agent-private-key", pair.privateKey);
  await addAudit({
    walletId,
    actor: "owner",
    action: "AGENT_KEY_MINTED",
    details: `Agent keypair '${label}' minted (public ${pair.publicKey.slice(0, 12)}…, private key ${stored ? "encrypted at rest" : "not persisted"})`,
  });

  return json(
    {
      walletId,
      label,
      publicKey: pair.publicKey,
      privateKey: pair.privateKey,
      recoverable: Boolean(stored),
      warning: stored
        ? "Private key stored encrypted at rest (KMS). Show once."
        : "Store the private key securely. It is shown only once.",
    },
    201,
  );
}
