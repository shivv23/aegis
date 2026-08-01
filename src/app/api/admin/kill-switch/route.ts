import type { NextRequest } from "next/server";
import { authenticate, authorize, error, json } from "@/core/api";
import { getGlobalKillSwitch, setGlobalKillSwitch } from "@/core/store";

export const runtime = "nodejs";

/**
 * Global fleet kill switch (C7). The master owner key can freeze every
 * wallet in the platform with a single call — the last line of defense
 * when agents across all orgs need to be stopped at once.
 */
export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const state = await getGlobalKillSwitch();
  return json({ global: state ?? { enabled: false } });
}

export async function POST(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const body = (await req.json().catch(() => null)) as
    | { enabled?: boolean; reason?: string }
    | null;
  if (!body || typeof body.enabled !== "boolean") {
    return error("enabled (boolean) and reason (string) required", 400);
  }
  const reason = body.reason?.trim() || (body.enabled ? "Super-admin kill switch" : "");
  const state = await setGlobalKillSwitch(reason, body.enabled);
  return json({ global: state });
}
