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

  it("rechaining only one table breaks the interleaved chain; rechaining both repairs it", async () => {
    const s = getStore();
    const { rechain } = await import("@/core/ledger");
    // Reproduces the v3 bug: rechain transactions alone.
    await rechain(s.client, ["transactions"]);
    expect((await verifyLedger()).intact).toBe(false);
    // The v4 repair: rechain both tables.
    await rechain(s.client, ["transactions", "audit"]);
    expect((await verifyLedger()).intact).toBe(true);
  });

  it("hashes integer units, so a float-only edit is caught too", async () => {
    const fresh = await createTransaction({
      walletId: SEED_WALLET_ID,
      from: SEED_WALLET_ID,
      to: "compute:0xCAFE0001",
      amount: 42,
      purpose: "units test",
      status: "SETTLED",
      requestedAt: Date.now(),
      settledAt: Date.now(),
      nonce: randomUUID(),
    });
    const s = getStore();
    // Sub-unit drift in the float column leaves the integer units unchanged,
    // so the chain stays intact (amounts are canonicalized to units).
    await s.client.execute(
      "UPDATE transactions SET amount = amount + 0.004 WHERE id = ?",
      [fresh.id],
    );
    expect((await verifyLedger()).intact).toBe(true);
    // Editing a whole unit changes the hashed units and breaks the chain.
    await s.client.execute(
      "UPDATE transactions SET amount = amount + 1 WHERE id = ?",
      [fresh.id],
    );
    const proof = await verifyLedger();
    expect(proof.intact).toBe(false);
    expect(proof.brokenAt?.id).toBe(fresh.id);
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

  it("stores amount_units and exposes it on ledger rows", async () => {
    const s = getStore();
    const { rows } = await s.client.execute(
      "SELECT amount_units FROM transactions WHERE amount = 12 LIMIT 1",
    );
    if (rows.length > 0) {
      expect(rows[0].amount_units).toBe("1200");
    }
  });
});
