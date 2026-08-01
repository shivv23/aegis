import type { NextRequest } from "next/server";
import { authenticate, authorize, error, json } from "@/core/api";
import {
  addAudit,
  listBudgetGroups,
  listOrgWallets,
  listOrgs,
  listWallets,
  resolveEffectiveWallet,
  updateOrgPolicy,
  updateTeamPolicy,
} from "@/core/store";
import type { Wallet, WalletPolicy } from "@/core/types";

export const runtime = "nodejs";

/**
 * GET  /api/delegation       org → team → wallet tree with effective policies
 * POST /api/delegation       set an org or team policy
 *   body: { kind: "org", orgId, policy } | { kind: "team", groupId, policy }
 */
export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const orgs = await listOrgs();
  const teams = await listBudgetGroups();
  const wallets = await listWallets();

  const tree = await Promise.all(
    orgs.map(async (org) => {
      const orgTeams = teams.filter((t) => t.orgId === org.id);
      const orgWallets = await listOrgWallets(org.id);
      const unassigned = await Promise.all(
        orgWallets
          .filter((w) => !orgTeams.some((t) => t.walletIds.includes(w.id)))
          .map(async (w) => ({ ...w, effective: await resolveEffectiveWallet(w.id) })),
      );
      const teamNodes = await Promise.all(
        orgTeams.map(async (team) => ({
          ...team,
          wallets: await Promise.all(
            team.walletIds
              .map((wid) => wallets.find((w) => w.id === wid))
              .filter((w): w is Wallet => Boolean(w))
              .map(async (w) => ({ ...w, effective: await resolveEffectiveWallet(w.id) })),
          ),
        })),
      );
      return { ...org, teams: teamNodes, unassignedWallets: unassigned };
    }),
  );

  return json({ tree });
}

function sanitizePolicy(input: Record<string, unknown>): WalletPolicy {
  const policy: WalletPolicy = {
    maxPerTx: Number(input.maxPerTx ?? 100),
    dailyLimit: Number(input.dailyLimit ?? 1000),
    monthlyLimit: Number(input.monthlyLimit ?? 5000),
    velocityLimitPerMin: Number(input.velocityLimitPerMin ?? 30),
    allowlist: Array.isArray(input.allowlist) ? (input.allowlist as string[]) : [],
  };
  for (const v of [policy.maxPerTx, policy.dailyLimit, policy.monthlyLimit, policy.velocityLimitPerMin]) {
    if (!Number.isFinite(v) || v < 0) throw new Error("Limits must be non-negative numbers");
  }
  return policy;
}

export async function POST(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const body = await req.json().catch(() => null) as {
    kind?: "org" | "team";
    orgId?: string;
    groupId?: string;
    policy?: Record<string, unknown>;
  } | null;
  if (!body || !body.policy) return error("orgId/groupId and policy required", 400);

  try {
    if (body.kind === "team") {
      if (!body.groupId) return error("groupId required", 400);
      const group = await updateTeamPolicy(body.groupId, sanitizePolicy(body.policy));
      if (!group) return error("Team not found", 404);
      await addAudit({
        walletId: "*",
        actor: "owner",
        action: "TEAM_POLICY_SET",
        details: `Team ${group.name} policy updated (monthly cap $${group.monthlyLimit})`,
      });
      return json({ group });
    }

    if (!body.orgId) return error("orgId required", 400);
    const org = await updateOrgPolicy(body.orgId, sanitizePolicy(body.policy));
    if (!org) return error("Org not found", 404);
    await addAudit({
      walletId: "*",
      actor: "owner",
      action: "ORG_POLICY_SET",
      details: `Org ${org.name} default policy updated`,
    });
    return json({ org });
  } catch (e) {
    return error(e instanceof Error ? e.message : "Invalid policy", 400);
  }
}
