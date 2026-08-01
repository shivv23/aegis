import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  addAudit,
  createTransaction,
  getStore,
  listTransactions,
  verifyLedger,
} from "@/core/store";
import { SEED_WALLET_ID } from "@/core/seed";

beforeAll(async () => {
  await getStore().ready;
});

describe("tamper-evident ledger", () => {
  it("seeds a verifiable chain", async () => {
    const proof = await verifyLedger();
    expect(proof.intact).toBe(true);
    expect(proof.rows).toBeGreaterThanOrEqual(6);
    expect(proof.headHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stays intact after live appends through the rail path", async () => {
    await createTransaction({
      walletId: SEED_WALLET_ID,
      from: SEED_WALLET_ID,
      to: "compute:0xCAFE0001",
      amount: 12,
      purpose: "chain test",
      status: "PENDING",
      requestedAt: Date.now(),
      pendingUntil: Date.now() + 5000,
      nonce: randomUUID(),
    });
    await addAudit({
      walletId: SEED_WALLET_ID,
      actor: "agent",
      action: "TX_REQUESTED",
      details: "12 to compute:0xCAFE0001 requested",
    });
    const proof = await verifyLedger();
    expect(proof.intact).toBe(true);
  });

  it("detects an edited transaction amount", async () => {
    const txs = await listTransactions(SEED_WALLET_ID);
    const victim = txs[0];
    const s = getStore();
    await s.client.execute(
      "UPDATE transactions SET amount = amount + 1000 WHERE id = ?",
      [victim.id],
    );
    const proof = await verifyLedger();
    expect(proof.intact).toBe(false);
    expect(proof.brokenAt?.table).toBe("transactions");
    expect(proof.brokenAt?.id).toBe(victim.id);
  });
});
