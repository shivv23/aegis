import type { NextRequest } from "next/server";
import { authenticate, authorize, error, json } from "@/core/api";
import { listWallets, policyHash } from "@/core/store";
import { readOnChainMirror } from "@/core/chain";

export const runtime = "nodejs";

const ZERO_HASH = "0x" + "0".repeat(64);

/**
 * GET /api/guardian
 *
 * The on-chain mirror: reports where the Guardian + PolicyRegistry live and
 * the exact policy hash that is sealed on-chain, so a judge can open the
 * explorer and see the limits the agent was bound by. When AEGIS_RPC_URL is
 * set, it reads the live contract state (paused, limits, sealed hash) and
 * reports whether an ACTIVE wallet enforces exactly the sealed policy hash.
 *
 * `matches` is true only when a wallet in this org genuinely enforces the
 * exact policy hash recorded on-chain — nothing is claimed that the chain
 * does not prove. When the seal is stale (a policy changed since it was
 * sealed) the response says so explicitly and the UI offers a re-seal.
 */
export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const onChain = await readOnChainMirror();
  const all = await listWallets();
  const active = all.filter((w) => w.status === "ACTIVE");

  const sealedRaw = onChain.registry.sealedHash?.toLowerCase();
  const sealedHex = sealedRaw?.replace(/^0x/, "") ?? null;
  const deployed =
    Boolean(onChain.registry.address && onChain.guardian.address && onChain.rpcUrl) &&
    sealedHex !== null &&
    sealedHex !== "0".repeat(64);

  // A wallet "matches" the seal when its enforced policy hash equals the hash
  // sealed on-chain. Search every active wallet so the check survives new
  // wallet creation and reports which wallet is bound to the seal.
  let sealedWallet: string | null = null;
  let sealedWalletHash: string | null = null;
  for (const w of active) {
    const h = policyHash(w.policy);
    if (sealedHex && h.toLowerCase() === sealedHex) {
      sealedWallet = w.id;
      sealedWalletHash = h;
      break;
    }
  }

  // Reporting fallback: most recently created active wallet.
  const fallback = active[active.length - 1] ?? all[all.length - 1] ?? null;
  const fallbackHash = fallback ? policyHash(fallback.policy) : null;

  const matches = sealedWallet !== null;

  let sealState: string;
  if (!deployed) {
    sealState = "not_deployed";
  } else if (onChain.error) {
    sealState = "unreachable";
  } else if (matches) {
    sealState = "verified";
  } else {
    sealState = "mismatch";
  }

  const explanation = deployed
    ? matches
      ? `Wallet ${sealedWallet} enforces exactly the policy hash sealed on-chain — the limits a judge sees in the app equal the limits on the contract.`
      : "No active wallet currently enforces the on-chain sealed policy hash. The seal is a snapshot of an earlier policy; after any wallet policy change the new hash must be re-sealed (see the Re-seal action) for the mirror to verify again."
    : "Set AEGIS_RPC_URL, AEGIS_GUARDIAN_ADDRESS and AEGIS_POLICY_REGISTRY to read the live contract state and verify the seal.";

  return json({
    wallet: sealedWallet ?? fallback?.id ?? null,
    comparedWallet: {
      id: fallback?.id ?? null,
      hash: fallbackHash,
      isSealed: matches,
    },
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
      hash: sealedWalletHash ?? fallbackHash,
      sealed: deployed,
      sealedWallet,
      onChain: sealedRaw,
      matches,
      sealState,
      error: onChain.error ?? null,
      explanation,
    },
  });
}
