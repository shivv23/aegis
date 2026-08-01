import { beforeAll, describe, expect, it } from "vitest";
import {
  getPendingPolicy,
  getStore,
  getWallet,
  listPolicyVersions,
  promoteDuePolicies,
  updatePolicy,
  verifyLedger,
} from "@/core/store";
import { SEED_WALLET_ID } from "@/core/seed";

beforeAll(async () => {
  await getStore().ready;
});

describe("policy versioning + timelock", () => {
  it("keeps the current policy enforced until the timelock elapses", async () => {
    const before = await getWallet(SEED_WALLET_ID);
    expect(before!.policy.maxPerTx).toBe(100);

    const { wallet, pending } = (await updatePolicy(SEED_WALLET_ID, {
      maxPerTx: 250,
    }))!;

    // Effective policy unchanged — guard still caps at $100.
    expect(wallet.policy.maxPerTx).toBe(100);
    expect(pending.status).toBe("PENDING");
    expect(pending.effectiveAt).toBeGreaterThan(Date.now());

    const current = await getWallet(SEED_WALLET_ID);
    expect(current!.policy.maxPerTx).toBe(100);
    expect(await getPendingPolicy(SEED_WALLET_ID)).not.toBeNull();
  });

  it("promotes the pending policy after the timelock and supersedes stale pendings", async () => {
    await updatePolicy(SEED_WALLET_ID, { dailyLimit: 2000 });
    await updatePolicy(SEED_WALLET_ID, { dailyLimit: 3000 });

    // One pending from the previous test + two from here.
    const versions = await listPolicyVersions(SEED_WALLET_ID);
    expect(versions.filter((v) => v.status === "PENDING")).toHaveLength(3);

    const promoted = await promoteDuePolicies(Date.now() + 60001);
    expect(promoted).toBe(1);

    // Newest pending wins: its snapshot carries the effective limits at edit
    // time, so maxPerTx is back to 100 and dailyLimit is the last write.
    const current = await getWallet(SEED_WALLET_ID);
    expect(current!.policy.maxPerTx).toBe(100);
    expect(current!.policy.dailyLimit).toBe(3000);

    const after = await listPolicyVersions(SEED_WALLET_ID);
    // Seed's ACTIVE version + the promoted one.
    expect(after.filter((v) => v.status === "ACTIVE")).toHaveLength(2);
    expect(after.some((v) => v.status === "SUPERSEDED")).toBe(true);
    expect(await getPendingPolicy(SEED_WALLET_ID)).toBeNull();
  });

  it("keeps the ledger verifiable through policy changes", async () => {
    const proof = await verifyLedger();
    expect(proof.intact).toBe(true);
  });
});
