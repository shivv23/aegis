import type { NextRequest } from "next/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { authenticate, authorize, error, json } from "@/core/api";
import { addAudit, createWallet, getOrg, listOrgWallets, listWallets, settleDue } from "@/core/store";
import { agentKeyFor, signKey } from "@/core/keys";
import type { WalletPolicy } from "@/core/types";

export const runtime = "nodejs";

const policySchema = z.object({
  maxPerTx: z.number().positive(),
  dailyLimit: z.number().positive(),
  monthlyLimit: z.number().positive(),
  velocityLimitPerMin: z.number().int().positive(),
  allowlist: z.array(z.string().min(1)),
});

const bodySchema = z.object({
  name: z.string().min(1),
  ownerDid: z.string().min(1),
  balance: z.number().nonnegative().default(0),
  policy: policySchema,
  orgId: z.string().min(1).optional(),
});

export async function POST(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error("Invalid wallet payload", 400);
  const { name, ownerDid, balance, policy } = parsed.data;

  // Org-scoped owner keys can only create wallets inside their own org.
  const orgId = claims?.orgId ?? parsed.data.orgId;
  if (orgId) {
    const org = await getOrg(orgId);
    if (!org) return error("Organization not found", 404);
    if (claims?.orgId && claims.orgId !== orgId) {
      return error("Key not authorized for this org", 403);
    }
  }

  const id = `wallet-${randomUUID().slice(0, 8)}`;
  const wallet = await createWallet({ id, name, ownerDid, balance, policy, orgId });
  await addAudit({
    walletId: id,
    actor: "owner",
    action: "WALLET_CREATED",
    details: `${name} provisioned with ${balance} and policy ${JSON.stringify(policy)}${orgId ? ` in org ${orgId}` : ""}`,
  });

  return json(
    {
      wallet,
      agentKey: await agentKeyFor(id),
      ownerKey: await signKey(id, "owner"),
      note: "agentKey is the only credential an agent should ever hold. ownerKey controls policy and the kill switch.",
    },
    201,
  );
}

export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  await settleDue();
  const wallets = claims?.orgId ? await listOrgWallets(claims.orgId) : await listWallets();
  return json({ wallets });
}

export type { WalletPolicy };
