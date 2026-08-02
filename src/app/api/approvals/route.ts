import type { NextRequest } from "next/server";
import { z } from "zod";
import { authenticate, authorize, authorizeRead, error, json } from "@/core/api";
import { listApprovals, MULTISIG_TTL_MS, proposeApproval } from "@/core/store";

export const runtime = "nodejs";

const proposeSchema = z.object({
  operation: z.literal("MINT_OWNER_KEY"),
  walletId: z.string().min(1),
  label: z.string().min(1).max(60),
});

/**
 * GET /api/approvals — list multi-sig approval requests.
 * POST /api/approvals — propose an owner-key issuance that needs 2-of-3 signers.
 */
export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorizeRead(claims);
  if (!authz.ok) return error(authz.reason!, 401);
  return json({ approvals: await listApprovals() });
}

export async function POST(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const parsed = proposeSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error("Invalid approval payload", 400);

  const { operation, walletId, label } = parsed.data;
  if (claims!.walletId !== "*" && claims!.walletId !== walletId) {
    return error("Key not authorized for this wallet", 403);
  }

  const approval = await proposeApproval({
    operation,
    walletId,
    label,
    proposer: claims!.keyId ?? claims!.walletId,
  });

  return json(
    {
      approval,
      required: approval.required,
      ttlMs: MULTISIG_TTL_MS,
    },
    202,
  );
}
