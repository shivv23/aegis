import { beforeAll, describe, expect, it } from "vitest";
import {
  agentReputation,
  createTransaction,
  createWallet,
  getStore,
  resetWalletReputation,
} from "@/core/store";
import type { WalletPolicy } from "@/core/types";

const policy: WalletPolicy = {
  maxPerTx: 100,
  dailyLimit: 1000,
  monthlyLimit: 5000,
  velocityLimitPerMin: 30,
  allowlist: ["compute:0xCAFE0001"],
};

let seq = 0;

beforeAll(async () => {
  await getStore().ready;
});

describe("agent reputation (D5)", () => {
  it("starts neutral for a fresh wallet", async () => {
    const wallet = await createWallet({ id: `wallet-rep-${++seq}`, name: "Fresh", ownerDid: "did:org:acme", balance: 500, policy });
    const r = await agentReputation(wallet.id);
    expect(r.settled).toBe(0);
    expect(r.blocked).toBe(0);
    expect(r.score).toBeGreaterThanOrEqual(0);
  });

  it("scores a settling agent well above the reputation gate", async () => {
    const wallet = await createWallet({ id: `wallet-rep-${++seq}`, name: "Good", ownerDid: "did:org:acme", balance: 500, policy });
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await createTransaction({ walletId: wallet.id, from: wallet.id, to: "compute:0xCAFE0001", amount: 10, purpose: "ok", status: "SETTLED", requestedAt: now, settledAt: now, nonce: `g-${i}` });
    }
    const r = await agentReputation(wallet.id);
    expect(r.settled).toBe(3);
    expect(r.score).toBeGreaterThan(50);
  });

  it("penalizes non-operator blocks (agent fault)", async () => {
    const wallet = await createWallet({ id: `wallet-rep-${++seq}`, name: "Sneaky", ownerDid: "did:org:acme", balance: 500, policy });
    const now = Date.now();
    await createTransaction({ walletId: wallet.id, from: wallet.id, to: "compute:0xCAFE0001", amount: 9999, purpose: "over cap", status: "BLOCKED", rejectionReason: "LIMIT_EXCEEDED", requestedAt: now, blockedAt: now, nonce: "b-1" });
    const r = await agentReputation(wallet.id);
    expect(r.blocked).toBe(1);
    expect(r.score).toBeLessThan(30);
  });

  it("does not penalize kill-switch freezes, so unfreeze recovers the agent", async () => {
    const wallet = await createWallet({ id: `wallet-rep-${++seq}`, name: "Frozen", ownerDid: "did:org:acme", balance: 500, policy });
    const now = Date.now();
    for (const reason of ["WALLET_FROZEN", "ORGANIZATION_FROZEN"] as const) {
      await createTransaction({ walletId: wallet.id, from: wallet.id, to: "compute:0xCAFE0001", amount: 10, purpose: "tried while frozen", status: "BLOCKED", rejectionReason: reason, requestedAt: now, blockedAt: now, nonce: `f-${reason}` });
    }
    const r = await agentReputation(wallet.id);
    expect(r.blocked).toBe(0);
    expect(r.score).toBeGreaterThanOrEqual(20);
  });

  it("never lets a reputation block deepen its own penalty (P1-2 deadlock fix)", async () => {
    const wallet = await createWallet({ id: `wallet-rep-${++seq}`, name: "Deadlocked", ownerDid: "did:org:acme", balance: 500, policy });
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await createTransaction({ walletId: wallet.id, from: wallet.id, to: "compute:0xCAFE0001", amount: 99, purpose: "denied", status: "BLOCKED", rejectionReason: "REPUTATION_BLOCKED", requestedAt: now + i, blockedAt: now + i, nonce: `rb-${i}` });
    }
    const r = await agentReputation(wallet.id);
    expect(r.blocked).toBe(0);
    // Floored at the neutral baseline, not sunk by the blocks themselves.
    expect(r.score).toBe(20);
  });

  it("operator reset ignores pre-reset history so a wallet can recover", async () => {
    const wallet = await createWallet({ id: `wallet-rep-${++seq}`, name: "ResetMe", ownerDid: "did:org:acme", balance: 500, policy });
    const now = Date.now();
    await createTransaction({ walletId: wallet.id, from: wallet.id, to: "compute:0xCAFE0001", amount: 9999, purpose: "bad", status: "BLOCKED", rejectionReason: "LIMIT_EXCEEDED", requestedAt: now, blockedAt: now, nonce: "pr-1" });
    resetWalletReputation(wallet.id);
    const after = await agentReputation(wallet.id);
    expect(after.blocked).toBe(0);
    expect(after.score).toBe(20);
  });
});
