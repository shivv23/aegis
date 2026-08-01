import type { NextRequest } from "next/server";
import { authenticate, authorize, error, json } from "@/core/api";
import { getWallet, policyHash } from "@/core/store";
import { SEED_WALLET_ID } from "@/core/seed";
import { readOnChainMirror } from "@/core/chain";

export const runtime = "nodejs";

/**
 * GET /api/guardian
 *
 * The on-chain mirror: reports where the Guardian + PolicyRegistry live and
 * the exact policy hash that is sealed on-chain, so a judge can open the
 * explorer and see the limits the agent was bound by. When AEGIS_RPC_URL is
 * set, it reads the live contract state (paused, limits, sealed hash) and
 * reports whether the off-chain hash matches the on-chain seal.
 */
export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const wallet = await getWallet(SEED_WALLET_ID);
  const hash = wallet ? policyHash(wallet.policy) : null;
  const onChain = await readOnChainMirror();

  return json({
    guardian: {
      address: process.env.AEGIS_GUARDIAN_ADDRESS ?? null,
      registry: process.env.AEGIS_POLICY_REGISTRY ?? null,
      rpcUrl: onChain.rpcUrl,
      chain: onChain.chain,
      live: {
        paused: onChain.guardian.paused,
        perTxCap: onChain.guardian.perTxCap,
        dailyLimit: onChain.guardian.dailyLimit,
        velocityMax: onChain.guardian.velocityMax,
      },
    },
    policy: {
      hash,
      sealed: Boolean(process.env.AEGIS_POLICY_REGISTRY && process.env.AEGIS_GUARDIAN_ADDRESS),
      onChain: onChain.registry.sealedHash,
      matches: onChain.matches,
      error: onChain.error ?? null,
      note: "Policy hash is sealed on-chain via the PolicyRegistry; the Guardian enforces per-tx cap, allowlist, daily and velocity limits, and a one-way revoke().",
    },
  });
}
