import type { NextRequest } from "next/server";
import { authenticate, authorize, error, json } from "@/core/api";
import { getStore } from "@/core/store";
import { seed } from "@/core/seed";
import { getEvents } from "@/core/store";

export const runtime = "nodejs";

/**
 * Demo-only reset: wipes the ledger and re-seeds. Keeps the demo repeatable
 * for judges without restarting the server.
 */
export async function POST(req: NextRequest) {
  if (process.env.AEGIS_DEMO_MODE === "0") {
    return json({ error: "Demo mode disabled" }, 403);
  }
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const s = getStore();
  await s.ready;
  await s.client.execute("DELETE FROM transactions");
  await s.client.execute("DELETE FROM audit");
  await s.client.execute("DELETE FROM wallets");
  await seed(s.client);

  const { listWallets } = await import("@/core/store");
  const wallets = await listWallets();
  getEvents().emit("reset", wallets);
  return json({ ok: true, wallets });
}
