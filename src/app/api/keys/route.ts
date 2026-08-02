import type { NextRequest } from "next/server";
import { z } from "zod";
import { authenticate, authorize, error, json } from "@/core/api";
import { agentKeyFor, masterOwnerKey, signKey } from "@/core/keys";
import { listAgentKeys } from "@/core/store";

export const runtime = "nodejs";

const OWNER = "owner";

const mintSchema = z.object({
  walletId: z.string().min(1),
  actions: z
    .array(z.enum(["mint_key", "approve", "transfer", "policy", "funding", "kill_switch"]))
    .max(12)
    .optional(),
  ttlMs: z.number().int().min(60_000).max(24 * 60 * 60 * 1000).optional(),
  keyId: z.string().optional(),
  orgId: z.string().optional(),
});

export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const walletId = req.nextUrl.searchParams.get("walletId");
  if (!walletId) return error("walletId query param required", 400);

  const role = req.nextUrl.searchParams.get("role");

  // Auditor: a read-only reviewer credential. It can inspect ledger, audit,
  // outbox, exports and guardian — never mutate anything (write routes
  // require `owner`).
  if (role === "auditor") {
    return json({
      auditorKey: await signKey(walletId, "auditor"),
      scope: "auditor",
    });
  }

  return json({
    ownerKey: await masterOwnerKey(),
    walletOwnerKey: await signKey(walletId, OWNER),
    agentKey: await agentKeyFor(walletId),
    agentKeys: await listAgentKeys(walletId),
  });
}

/**
 * POST /api/keys — mint a scoped + time-boxed + action-scoped owner key.
 * `ttlMs` sets a short-lived JWT (60s..24h); `actions` restricts the key to
 * exactly those operations (enforced by authorize()'s action gate).
 */
export async function POST(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);
  if (claims!.walletId !== "*") return error("Only the master key can mint keys", 403);

  const parsed = mintSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error("Invalid key mint payload", 400);

  const key = await signKey(parsed.data.walletId, OWNER, {
    actions: parsed.data.actions,
    ttlMs: parsed.data.ttlMs,
    keyId: parsed.data.keyId,
    orgId: parsed.data.orgId,
  });

  return json({
    key,
    scope: OWNER,
    actions: parsed.data.actions,
    ttlMs: parsed.data.ttlMs ?? null,
    note: parsed.data.ttlMs
      ? `This key expires in ${Math.round(parsed.data.ttlMs / 1000)}s and can only perform: ${parsed.data.actions?.join(", ") ?? "nothing"}`
      : undefined,
  }, 201);
}
