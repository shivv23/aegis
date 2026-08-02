import { json } from "@/core/api";
import { masterOwnerKey, signKey } from "@/core/keys";
import { SEED_WALLET_ID } from "@/core/seed";
import { ensureDefaultSigners, getWallet } from "@/core/store";

export const runtime = "nodejs";

/**
 * Demo-only bootstrap: hands the frontend the master owner key so the
 * dashboard can drive the full lifecycle without manual credential entry.
 * Also seeds the three multi-sig signers and returns their owner-scoped keys
 * (deterministic, re-derivable), so owner-key issuance can be demoed 2-of-3
 * out of the box. In production this would be a proper OAuth/API-key flow.
 */
export async function GET() {
  if (process.env.AEGIS_DEMO_MODE === "0") {
    return json({ error: "Demo mode disabled" }, 403);
  }
  const wallet = await getWallet(SEED_WALLET_ID);
  const signers = await ensureDefaultSigners();
  return json({
    ownerKey: await masterOwnerKey(),
    // Only reported when the opt-in demo seed actually provisioned the wallet.
    seedWalletId: wallet ? SEED_WALLET_ID : null,
    seeded: Boolean(wallet),
    signers: await Promise.all(
      signers.map(async (s) => ({
        id: s.id,
        name: s.name,
        role: s.role,
        key: await signKey("*", "owner", { keyId: s.id }),
      })),
    ),
  });
}
