import { beforeAll, describe, expect, it } from "vitest";
import { createOrg, createWallet, getOrg, getStore, listOrgWallets, listOrgs } from "@/core/store";
import { authorizeOrg, authorizeWalletOrg } from "@/core/api";
import { signKey, verifyKey } from "@/core/keys";
import { SEED_ORG_ID, SEED_WALLET_ID } from "@/core/seed";

beforeAll(async () => {
  await getStore().ready;
});

describe("multi-tenant orgs", () => {
  it("seeds the demo org and attaches the seeded wallet", async () => {
    const org = await getOrg(SEED_ORG_ID);
    expect(org).not.toBeNull();
    expect(org!.name).toBe("Acme Labs");
    const wallets = await listOrgWallets(SEED_ORG_ID);
    expect(wallets.map((w) => w.id)).toContain(SEED_WALLET_ID);
  });

  it("creates, lists, and reads orgs", async () => {
    const org = await createOrg("Test Corp");
    expect(org.id).toMatch(/^org-/);
    expect((await listOrgs()).some((o) => o.id === org.id)).toBe(true);
    const read = await getOrg(org.id);
    expect(read!.name).toBe("Test Corp");
  });

  it("creates a wallet inside an org", async () => {
    const org = await createOrg("Wallet Org");
    const wallet = await createWallet({
      id: "wallet-orgtest",
      name: "Org Bot",
      ownerDid: "did:org:test",
      balance: 500,
      orgId: org.id,
      policy: {
        maxPerTx: 100,
        dailyLimit: 1000,
        monthlyLimit: 5000,
        velocityLimitPerMin: 30,
        allowlist: ["compute:0xCAFE0001"],
      },
    });
    expect(wallet.orgId).toBe(org.id);
    expect((await listOrgWallets(org.id)).some((w) => w.id === "wallet-orgtest")).toBe(true);
  });
});

describe("org-scoped authorization", () => {
  it("round-trips orgId through signed owner keys", async () => {
    const org = await createOrg("Key Org");
    const token = await signKey("*", "owner", { orgId: org.id });
    const claims = await verifyKey(token);
    expect(claims?.orgId).toBe(org.id);
  });

  it("master key can manage any org", () => {
    expect(authorizeOrg({ walletId: "*", scope: "owner", role: "wallet-owner" }, "org-x").ok).toBe(true);
  });

  it("org owner can manage its own org but not another", async () => {
    const org = await createOrg("Auth Org");
    const claims = await verifyKey(await signKey("*", "owner", { orgId: org.id }));
    expect(authorizeOrg(claims, org.id).ok).toBe(true);
    expect(authorizeOrg(claims, "org-other").ok).toBe(false);
  });

  it("org owner cannot touch wallets in another org", async () => {
    const org = await createOrg("Isolation Org");
    const claims = await verifyKey(await signKey("*", "owner", { orgId: org.id }));
    expect(authorizeWalletOrg(claims, "org-other").ok).toBe(false);
    expect(authorizeWalletOrg(claims, org.id).ok).toBe(true);
    expect(authorizeWalletOrg(claims, undefined).ok).toBe(false);
  });

  it("agent keys cannot act as org owners", () => {
    expect(authorizeOrg({ walletId: "w", scope: "agent", role: "agent" }, "org-x").ok).toBe(false);
  });
});
