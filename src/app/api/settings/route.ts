import type { NextRequest } from "next/server";
import { authenticate, authorize, error, json } from "@/core/api";
import { getUserSettings, setUserSettings } from "@/core/store";

export const runtime = "nodejs";

const CURRENCIES = ["USD", "USDC", "EUR", "INR", "ETH"];

/**
 * Per-user display settings (E6): currency + timezone. Purely presentational —
 * the ledger stays UTC/USD-notional everywhere.
 */
export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const owner = claims!.role === "superadmin" ? "master" : `wallet:${claims!.walletId}`;
  const settings = await getUserSettings(owner);
  return json({ settings, supportedCurrencies: CURRENCIES });
}

export async function PUT(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const body = (await req.json().catch(() => null)) as
    | { currency?: string; timezone?: string }
    | null;
  if (!body) return error("currency or timezone required", 400);

  const patch: { currency?: string; timezone?: string } = {};
  if (body.currency) {
    if (!CURRENCIES.includes(body.currency)) return error("Unsupported currency", 400);
    patch.currency = body.currency;
  }
  if (body.timezone) {
    try {
      Intl.DateTimeFormat("en-US", { timeZone: body.timezone });
    } catch {
      return error("Invalid timezone", 400);
    }
    patch.timezone = body.timezone;
  }

  const owner = claims!.role === "superadmin" ? "master" : `wallet:${claims!.walletId}`;
  const settings = await setUserSettings(owner, patch);
  return json({ settings });
}
