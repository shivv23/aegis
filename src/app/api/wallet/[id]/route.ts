import type { NextRequest } from "next/server";
import { z } from "zod";
import { authenticate, authorize, error, json } from "@/core/api";
import { addAudit, getPendingPolicy, getWallet, listAudit, listPolicyVersions, listTransactions, settleDue, updatePolicy } from "@/core/store";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const claims = await authenticate(_req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  await settleDue();
  const wallet = await getWallet(id);
  if (!wallet) return error("Wallet not found", 404);

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
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error("Invalid policy patch", 400);

  const result = await updatePolicy(id, parsed.data, claims!.walletId);
  if (!result) return error("Wallet not found", 404);

  const { wallet, pending } = result;

  await addAudit({
    walletId: id,
    actor: "owner",
    action: "POLICY_UPDATED",
    details: `Policy changed, effective ${
      pending.effectiveAt <= Date.now() ? "immediately" : `at ${new Date(pending.effectiveAt).toISOString()}`
    } (hash ${pending.policyHash.slice(0, 12)}): ${JSON.stringify(parsed.data)}`,
  });

  return json({ wallet, pendingPolicy: pending });
}
