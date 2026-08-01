import { json } from "@/core/api";
import { masterOwnerKey } from "@/core/keys";
import { SEED_WALLET_ID } from "@/core/seed";
import { getWallet } from "@/core/store";

export const runtime = "nodejs";

/**
 * Demo-only bootstrap: hands the frontend the master owner key so the
 * dashboard can drive the full lifecycle without manual credential entry.
 * In production this would be a proper OAuth/API-key flow.
 */
export async function GET() {
  if (process.env.AEGIS_DEMO_MODE === "0") {
    return json({ error: "Demo mode disabled" }, 403);
  }
  const wallet = await getWallet(SEED_WALLET_ID);
  return json({
    ownerKey: await masterOwnerKey(),
    seedWalletId: SEED_WALLET_ID,
    seeded: Boolean(wallet),
  });
}
