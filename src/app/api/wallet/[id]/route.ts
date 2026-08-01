import type { NextRequest } from "next/server";
import { z } from "zod";
import { authenticate, authorize, error, json } from "@/core/api";
import { addAudit, getWallet, listAudit, listTransactions, settleDue, updatePolicy } from "@/core/store";

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

  const [transactions, audit] = await Promise.all([
    listTransactions(id),
    listAudit(id),
  ]);
  return json({ wallet, transactions, audit });
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

  const wallet = await updatePolicy(id, parsed.data);
  if (!wallet) return error("Wallet not found", 404);

  await addAudit({
    walletId: id,
    actor: "owner",
    action: "POLICY_UPDATED",
    details: JSON.stringify(parsed.data),
  });

  return json({ wallet });
}
