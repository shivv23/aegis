import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createBudgetGroup,
  createOrg,
  createWallet,
  getStore,
  resolveEffectiveWallet,
  updateOrgPolicy,
  updateTeamPolicy,
} from "@/core/store";
import { mergePolicy } from "@/core/delegation";
import { runGuard, spendContext } from "@/core/guard";
import type { Wallet, WalletPolicy } from "@/core/types";

const baseWalletPolicy: WalletPolicy = {
  maxPerTx: 200,
  dailyLimit: 2000,
  monthlyLimit: 20000,
  velocityLimitPerMin: 20,
  allowlist: [],
};

beforeAll(async () => {
  await getStore().ready;
});

afterEach(async () => {
  const s = getStore();
  await s.ready;
  await s.client.execute("DELETE FROM budget_group_wallets");
  await s.client.execute("DELETE FROM budget_groups");
  await s.client.execute("DELETE FROM wallets WHERE id LIKE 'wallet-d4-%'");
  await s.client.execute("DELETE FROM orgs WHERE id LIKE 'org-d4-%'");
});

describe("policy merge (D4)", () => {
  it("inherits org defaults where the wallet leaves fields unset", () => {
    const org: Partial<WalletPolicy> = { maxPerTx: 50, monthlyLimit: 5000 };
    const { policy, sources } = mergePolicy(baseWalletPolicy, org);
    expect(policy.maxPerTx).toBe(50);
    expect(policy.monthlyLimit).toBe(5000);
    expect(policy.dailyLimit).toBe(2000);
    expect(policy.velocityLimitPerMin).toBe(20);
    expect(sources.maxPerTx).toBe("org");
    expect(sources.dailyLimit).toBe("wallet");
  });

  it("caps the wallet at the tightest level and a child cannot loosen", () => {
    const org: Partial<WalletPolicy> = { maxPerTx: 50 };
    const team: Partial<WalletPolicy> = { maxPerTx: 100, dailyLimit: 1500 };
    const wallet: WalletPolicy = { ...baseWalletPolicy, maxPerTx: 200 };
    const { policy, sources } = mergePolicy(wallet, org, team);
    expect(policy.maxPerTx).toBe(50); // org caps despite team 100 / wallet 200
    expect(sources.maxPerTx).toBe("org");
    expect(policy.dailyLimit).toBe(1500);
    expect(sources.dailyLimit).toBe("team");
  });

  it("inherits allowlist from the most specific non-empty level", () => {
    const org: Partial<WalletPolicy> = { allowlist: ["vendor:org"] };
    const team: Partial<WalletPolicy> = { allowlist: ["vendor:team"] };
    expect(mergePolicy(baseWalletPolicy, org, team).policy.allowlist).toEqual(["vendor:team"]);
    expect(mergePolicy(baseWalletPolicy, org).policy.allowlist).toEqual(["vendor:org"]);
    expect(mergePolicy(baseWalletPolicy).policy.allowlist).toEqual([]);
  });
});

describe("delegation tree integration (D4)", () => {
  it("resolves the effective policy through org → wallet", async () => {
    const org = await createOrg("Ops");
    await updateOrgPolicy(org.id, {
      maxPerTx: 40,
      dailyLimit: 1000,
      monthlyLimit: 10000,
      velocityLimitPerMin: 10,
      allowlist: ["vendor:d4"],
    });
    const wallet = await createWallet({
      id: "wallet-d4-1",
      name: "trader",
      ownerDid: "did:aegis:trader",
      balance: 1000,
      policy: {
        maxPerTx: 500,
        dailyLimit: 5000,
        monthlyLimit: 50000,
        velocityLimitPerMin: 10,
        allowlist: ["vendor:d4"],
      },
      orgId: org.id,
    });

    const eff = await resolveEffectiveWallet(wallet.id);
    expect(eff).not.toBeNull();
    expect(eff!.policy.maxPerTx).toBe(40);
    expect(eff!.policy.monthlyLimit).toBe(10000);
    expect(eff!.effectiveSources?.maxPerTx).toBe("org");
    expect(eff!.effectiveSources?.velocityLimitPerMin).toBe("wallet");
  });

  it("team policy caps the wallet and the guard enforces the cap", async () => {
    const org = await createOrg("Ops");
    await updateOrgPolicy(org.id, {
      maxPerTx: 40,
      dailyLimit: 1000,
      monthlyLimit: 10000,
      velocityLimitPerMin: 10,
      allowlist: ["vendor:d4"],
    });
    const wallet = await createWallet({
      id: "wallet-d4-2",
      name: "trader",
      ownerDid: "did:aegis:trader2",
      balance: 1000,
      policy: {
        maxPerTx: 500,
        dailyLimit: 5000,
        monthlyLimit: 50000,
        velocityLimitPerMin: 10,
        allowlist: ["vendor:d4"],
      },
      orgId: org.id,
    });
    const team = await createBudgetGroup({
      name: "Team X",
      monthlyLimit: 2000,
      orgId: org.id,
      walletIds: [wallet.id],
    });
    await updateTeamPolicy(team.id, {
      maxPerTx: 30,
      dailyLimit: 1000,
      monthlyLimit: 10000,
      velocityLimitPerMin: 10,
      allowlist: ["vendor:d4"],
    });

    const eff = await resolveEffectiveWallet(wallet.id);
    expect(eff).not.toBeNull();
    expect(eff!.policy.maxPerTx).toBe(30); // team tighter than org's 40

    const ctx = spendContext(wallet.id, Date.now(), []);
    expect(runGuard(eff!, 25, "vendor:d4", ctx).allowed).toBe(true);
    const denied = runGuard(eff!, 35, "vendor:d4", ctx);
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("LIMIT_EXCEEDED");
  });

  it("returns a wallet with no policy on levels absent", async () => {
    const eff = await resolveEffectiveWallet("wallet-d4-missing");
    expect(eff).toBeNull();
  });
});
