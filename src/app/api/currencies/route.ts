import type { NextRequest } from "next/server";
import { authenticate, authorizeRead, error, json } from "@/core/api";
import { listCurrencies } from "@/core/currency";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorizeRead(claims);
  if (!authz.ok) return error(authz.reason!, 401);
  return json({ currencies: listCurrencies() });
}
