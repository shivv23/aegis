import type { NextRequest } from "next/server";
import { authenticate, authorize, error, json } from "@/core/api";
import { getEvents, resetStore } from "@/core/store";

export const runtime = "nodejs";

/**
 * Demo-only reset: wipes the ledger and re-seeds through the chained-insert
 * path so the ledger stays verifiable. Keeps the demo repeatable.
 */
export async function POST(req: NextRequest) {
  if (process.env.AEGIS_DEMO_MODE === "0") {
    return json({ error: "Demo mode disabled" }, 403);
  }
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const wallets = await resetStore({ reseed: true });
  getEvents().emit("reset", wallets);
  return json({ ok: true, wallets });
}
