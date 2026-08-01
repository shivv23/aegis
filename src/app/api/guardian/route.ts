import type { NextRequest } from "next/server";
import { authenticate, authorize, error, json } from "@/core/api";
import { getWallet, policyHash } from "@/core/store";
import { SEED_WALLET_ID } from "@/core/seed";

export const runtime = "nodejs";

/**
 * GET /api/guardian
 *
 * The on-chain mirror: reports where the Guardian + PolicyRegistry live and
 * the exact policy hash that is (or should be) sealed on-chain, so a judge
 * can open the explorer and see the limits the agent was bound by.
 */
export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const wallet = await getWallet(SEED_WALLET_ID);
  const hash = wallet ? policyHash(wallet.policy) : null;

  return json({
    guardian: {
      address: process.env.AEGIS_GUARDIAN_ADDRESS ?? null,
      registry: process.env.AEGIS_POLICY_REGISTRY ?? null,
      rpcUrl: process.env.AEGIS_RPC_URL ?? null,
      chain: process.env.AEGIS_CHAIN_NAME ?? "hardhat (local)",
    },
    policy: {
      hash,
      sealed: Boolean(process.env.AEGIS_POLICY_REGISTRY && process.env.AEGIS_GUARDIAN_ADDRESS),
      note: "Policy hash is sealed on-chain via the PolicyRegistry; the Guardian enforces per-tx cap, allowlist, daily and velocity limits, and a one-way revoke().",
    },
  });
}
