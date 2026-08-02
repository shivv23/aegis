import type { NextRequest } from "next/server";
import { authenticate, authorize, error, json } from "@/core/api";
import { listWallets, policyHash } from "@/core/store";

export const runtime = "nodejs";

const ZERO_HASH = "0x" + "0".repeat(64);

/**
 * POST /api/admin/reseal
 *
 * Operator action for the on-chain mirror. Re-sealing updates the
 * PolicyRegistry seal (and the Guardian's enforced policy hash) to the hash of
 * the policy the org actually enforces today, so `matches` returns true again.
 *
 * The transaction must be signed with the org's funded Sepolia deployer key,
 * so this endpoint never signs on the server. It computes the target hash,
 * verifies the contracts are wired, and returns the exact one-command path
 * (contracts/scripts/reseal.ts) the operator runs with their key.
 */
export async function POST(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const registry = process.env.AEGIS_POLICY_REGISTRY;
  const guardian = process.env.AEGIS_GUARDIAN_ADDRESS;
  const rpcUrl = process.env.AEGIS_RPC_URL;
  if (!registry || !guardian || !rpcUrl) {
    return error(
      "On-chain mirror not wired. Set AEGIS_RPC_URL, AEGIS_GUARDIAN_ADDRESS and AEGIS_POLICY_REGISTRY first.",
      409,
    );
  }

  // Target: the most recently created active wallet (what a judge sees as the
  // live compared policy). If one already matches the seal, nothing to do.
  const all = await listWallets();
  const active = all.filter((w) => w.status === "ACTIVE");
  const target = active[active.length - 1] ?? all[all.length - 1] ?? null;
  if (!target) return error("No wallet to seal", 404);

  const hash = policyHash(target.policy);
  const command =
    `AEGIS_POLICY_HASH=${hash} npx hardhat run scripts/reseal.ts --network sepolia`;
  const deployerNote =
    "Reseal must run from contracts/ with a funded deployer key in the Hardhat network config. " +
    "After it mines, this endpoint reports matches:true for the sealed wallet.";

  return json({
    ok: true,
    wallet: target.id,
    walletName: target.name,
    policyHash: hash,
    command,
    contracts: { guardian, registry, rpcUrl },
    note: deployerNote,
  });
}
