import type { NextRequest } from "next/server";
import { authenticate, authorize, error, json } from "@/core/api";
import { addAudit, getSecret } from "@/core/store";
import { secretsEnabled } from "@/core/secrets";

export const runtime = "nodejs";

/**
 * GET /api/keys/recover?walletId=…
 * Owner-scoped recovery of an agent private key that was persisted
 * envelope-encrypted at mint/rotate time. Only available when a KMS master
 * key is configured; otherwise it returns 404.
 */
export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const walletId = req.nextUrl.searchParams.get("walletId");
  if (!walletId) return error("walletId required", 400);
  if (claims!.walletId !== "*" && claims!.walletId !== walletId) {
    return error("Key not authorized for this wallet", 403);
  }
  if (!(await secretsEnabled())) {
    return error("Secrets encryption is not enabled (no AEGIS_KMS_MASTER)", 404);
  }

  const privateKey = await getSecret(walletId, "agent-private-key");
  if (!privateKey) return error("No recoverable private key stored for this wallet", 404);

  await addAudit({
    walletId,
    actor: "owner",
    action: "AGENT_KEY_RECOVERED",
    details: `Recovered encrypted agent private key for ${walletId}`,
  });

  return json({ walletId, privateKey, warning: "Store the private key securely. Shown on recovery." });
}
