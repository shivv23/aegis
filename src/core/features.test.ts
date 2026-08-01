import { beforeAll, describe, expect, it } from "vitest";
import {
  addWalletToBudgetGroup,
  createBudgetGroup,
  createEscrow,
  createWallet,
  creditWallet,
  getBudgetGroupForWallet,
  groupSpendLast30d,
  listBudgetGroups,
  listEscrows,
  listUsage,
  recordUsage,
  refundEscrow,
  releaseEscrow,
  revokeAgentKey,
  rotateAgentKey,
  registerAgentKey,
  upsertCounterparty,
  listCounterparties,
  getCounterparty,
  listAgentKeys,
  getActiveAgentKey,
  getStore,
} from "@/core/store";
import { SEED_WALLET_ID } from "@/core/seed";

beforeAll(async () => {
  await getStore().ready;
});

const policy = {
  maxPerTx: 100,
  dailyLimit: 1000,
  monthlyLimit: 5000,
  velocityLimitPerMin: 30,
  allowlist: ["compute:0xCAFE0001", "api:0xBEEF0002", "storage:0xDEAD0003"],
};

describe("budget groups", () => {
  it("creates a group and computes cross-wallet spend", async () => {
    const group = await createBudgetGroup({ name: "Eng", monthlyLimit: 2000, walletIds: [SEED_WALLET_ID] });
    const listed = await listBudgetGroups();
    expect(listed.some((g) => g.id === group.id)).toBe(true);
    const spent = await groupSpendLast30d(group, Date.now());
    expect(typeof spent).toBe("number");
    expect(spent).toBeGreaterThanOrEqual(0);
  });

  it("adds wallets and resolves the group for a wallet", async () => {
    const group = await createBudgetGroup({ name: "Ops", monthlyLimit: 1500 });
    const wallet = await createWallet({
      id: "wallet-group2",
      name: "Ops Bot",
      ownerDid: "did:org:test",
      balance: 0,
      policy,
    });
    await addWalletToBudgetGroup(group.id, wallet.id);
    const found = await getBudgetGroupForWallet(wallet.id);
    expect(found).not.toBeNull();
    expect(found!.name).toBe("Ops");
  });
});

describe("counterparty registry", () => {
  it("upserts and reads a counterparty", async () => {
    const cp = await upsertCounterparty({ name: "Vendor A", address: "vendor:a", flags: ["HIGH_RISK"] });
    expect(cp.id).toMatch(/^cp-/);
    expect(cp.flags).toContain("HIGH_RISK");
    expect((await getCounterparty("vendor:a"))?.name).toBe("Vendor A");
    const updated = await upsertCounterparty({ name: "Vendor A", address: "vendor:a", status: "BLOCKED" });
    expect(updated.status).toBe("BLOCKED");
    expect((await listCounterparties()).some((c) => c.address === "vendor:a")).toBe(true);
  });
});

describe("escrows", () => {
  it("creates, releases, and refunds an escrow", async () => {
    const before = await getStore().client.execute("SELECT balance FROM wallets WHERE id = ?", [SEED_WALLET_ID]);
    const escrow = await createEscrow({ walletId: SEED_WALLET_ID, to: "vendor:a", amount: 50, condition: "invoice #42 paid" });
    expect(escrow.status).toBe("HELD");
    const after = await getStore().client.execute("SELECT balance FROM wallets WHERE id = ?", [SEED_WALLET_ID]);
    expect(Number(after.rows[0].balance)).toBe(Number(before.rows[0].balance) - 50);

    const released = await releaseEscrow(escrow.id);
    expect(released!.status).toBe("RELEASED");
    expect((await listEscrows(SEED_WALLET_ID)).some((e) => e.id === escrow.id)).toBe(true);
  });

  it("refunds the escrowed amount on refund", async () => {
    const escrow = await createEscrow({ walletId: SEED_WALLET_ID, to: "vendor:b", amount: 30, condition: "po #9" });
    const refunded = await refundEscrow(escrow.id);
    expect(refunded!.status).toBe("REFUNDED");
    const row = await getStore().client.execute("SELECT balance FROM wallets WHERE id = ?", [SEED_WALLET_ID]);
    expect(Number(row.rows[0].balance)).toBeGreaterThan(0);
  });
});

describe("usage metering", () => {
  it("records and lists usage rows", async () => {
    await recordUsage({ walletId: SEED_WALLET_ID, txId: "tx-usage-1", amount: 25, rail: "sandbox" });
    const usage = await listUsage(SEED_WALLET_ID);
    expect(usage.some((u) => u.txId === "tx-usage-1" && u.amount === 25)).toBe(true);
  });
});

describe("key lifecycle", () => {
  it("registers keys with expiry and ACL", async () => {
    const key = await registerAgentKey(SEED_WALLET_ID, "pub-rotate-a", "primary", {
      expiresAt: Date.now() + 100000,
      acl: { scope: "agent", role: "agent", walletId: SEED_WALLET_ID, actions: ["transfer"] },
    });
    expect(key.expiresAt).toBeGreaterThan(0);
    expect(key.acl?.actions).toContain("transfer");
    expect((await listAgentKeys(SEED_WALLET_ID)).some((k) => k.publicKey === "pub-rotate-a")).toBe(true);
  });

  it("rotation revokes the old key and mints a new one", async () => {
    await registerAgentKey(SEED_WALLET_ID, "pub-rotate-old", "old");
    const rotated = await rotateAgentKey(SEED_WALLET_ID, "pub-rotate-old", "pub-rotate-new", "new");
    expect(rotated.publicKey).toBe("pub-rotate-new");
    const keys = await listAgentKeys(SEED_WALLET_ID);
    const oldKey = keys.find((k) => k.publicKey === "pub-rotate-old");
    expect(oldKey?.revokedAt).toBeGreaterThan(0);
  });

  it("expired keys are not returned as active", async () => {
    const expiredKey = "pub-expired";
    await registerAgentKey(SEED_WALLET_ID, expiredKey, "expired", { expiresAt: Date.now() - 1000 });
    expect(await getActiveAgentKey(SEED_WALLET_ID, expiredKey)).toBeNull();
  });

  it("revoke marks a key revoked", async () => {
    await registerAgentKey(SEED_WALLET_ID, "pub-revoke-me", "revoke");
    await revokeAgentKey(SEED_WALLET_ID, "pub-revoke-me");
    const key = (await listAgentKeys(SEED_WALLET_ID)).find((k) => k.publicKey === "pub-revoke-me");
    expect(key?.revokedAt).toBeGreaterThan(0);
  });
});

describe("wallet credit helper", () => {
  it("credits a wallet balance", async () => {
    await createWallet({
      id: "wallet-credit",
      name: "Credit Bot",
      ownerDid: "did:org:test",
      balance: 100,
      policy,
    });
    const credited = await creditWallet("wallet-credit", 40);
    expect(credited!.balance).toBe(140);
  });
});
