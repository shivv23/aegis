import type { NextRequest } from "next/server";
import { z } from "zod";
import { authenticate, authorize, authorizeRead, authorizeWalletOrg, error, json } from "@/core/api";
import { addAudit, getPendingPolicy, getWallet, listAudit, listPolicyVersions, listTransactions, settleDue, updatePolicy } from "@/core/store";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const claims = await authenticate(_req);
  const authz = authorizeRead(claims);
  if (!authz.ok) return error(authz.reason!, 401);

  await settleDue();
  const wallet = await getWallet(id);
  if (!wallet) return error("Wallet not found", 404);
  const orgz = authorizeWalletOrg(claims, wallet.orgId);
  if (!orgz.ok) return error(orgz.reason!, 403);

  const [transactions, audit, pendingPolicy, policyVersions] = await Promise.all([
    listTransactions(id),
    listAudit(id),
    getPendingPolicy(id),
    listPolicyVersions(id),
  ]);
  return json({ wallet, transactions, audit, pendingPolicy, policyVersions });
}

const patchSchema = z.object({
  maxPerTx: z.number().positive().optional(),
  dailyLimit: z.number().positive().optional(),
  monthlyLimit: z.number().positive().optional(),
  velocityLimitPerMin: z.number().int().positive().optional(),
  allowlist: z.array(z.string().min(1)).optional(),
  spendingWindows: z
    .array(z.object({ startHour: z.number().int().min(0).max(23), endHour: z.number().int().min(0).max(23) }))
    .optional(),
  regionAllowlist: z.array(z.string().min(1)).optional(),
  requireApproval: z.boolean().optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner", undefined, "policy");
  if (!authz.ok) return error(authz.reason!, 401);

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error("Invalid policy patch", 400);

  const existing = await getWallet(id);
  if (!existing) return error("Wallet not found", 404);
  const orgz = authorizeWalletOrg(claims, existing.orgId);
  if (!orgz.ok) return error(orgz.reason!, 403);

  const result = await updatePolicy(id, parsed.data, claims!.walletId, {
    requireApproval: parsed.data.requireApproval,
  });
  if (!result) return error("Wallet not found", 404);

  const { wallet, pending, approval } = result;
  const pendingId = pending ?? approval;

  await addAudit({
    walletId: id,
    actor: "owner",
    action: approval ? "POLICY_CHANGE_PROPOSED" : "POLICY_UPDATED",
    details: approval
      ? `Policy change submitted for 2-of-3 signer approval (${approval.id}); effective once approved + timelock elapses`
      : `Policy changed, effective ${
          pendingId && pendingId.effectiveAt <= Date.now() ? "immediately" : `at ${pendingId ? new Date(pendingId.effectiveAt).toISOString() : "n/a"}`
        } (hash ${pendingId.policyHash.slice(0, 12)}): ${JSON.stringify(parsed.data)}`,
  });

  return json({
    wallet,
    pendingPolicy: pendingId,
    requiresApproval: Boolean(approval),
    approval,
    note: approval
      ? "This policy change will not apply until 2-of-3 signers approve and the timelock elapses."
      : undefined,
  });
}
