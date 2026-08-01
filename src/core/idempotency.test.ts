import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createEscrow,
  createTransaction,
  findEscrowByIdempotencyKey,
  findTransactionByIdempotencyKey,
  getStore,
} from "@/core/store";
import { SEED_WALLET_ID } from "@/core/seed";

beforeAll(async () => {
  await getStore().ready;
});

describe("idempotency keys (A3)", () => {
  it("stores and returns the original transaction on replay", async () => {
    const key = `ik-${randomUUID()}`;
    const tx = await createTransaction({
      walletId: SEED_WALLET_ID,
      from: SEED_WALLET_ID,
      to: "compute:0xCAFE0001",
      amount: 7,
      purpose: "idempotent",
      status: "PENDING",
      requestedAt: Date.now(),
      pendingUntil: Date.now() + 5000,
      nonce: randomUUID(),
      idempotencyKey: key,
    });
    const found = await findTransactionByIdempotencyKey(key);
    expect(found?.id).toBe(tx.id);
    // Replaying the same key does not create a second row.
    await createTransaction({
      walletId: SEED_WALLET_ID,
      from: SEED_WALLET_ID,
      to: "compute:0xCAFE0001",
      amount: 7,
      purpose: "idempotent",
      status: "PENDING",
      requestedAt: Date.now(),
      pendingUntil: Date.now() + 5000,
      nonce: randomUUID(),
      idempotencyKey: key,
    });
    const { rows } = await getStore().client.execute(
      "SELECT COUNT(*) AS n FROM transactions WHERE idempotency_key = ?",
      [key],
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  it("stores and returns the original escrow on replay", async () => {
    const key = `ik-esc-${randomUUID()}`;
    const escrow = await createEscrow({
      walletId: SEED_WALLET_ID,
      to: "vendor:0xCAFE0001",
      amount: 9,
      condition: "invoice paid",
      idempotencyKey: key,
    });
    const found = await findEscrowByIdempotencyKey(key);
    expect(found?.id).toBe(escrow.id);
  });

  it("returns null for unknown keys", async () => {
    expect(await findTransactionByIdempotencyKey("nope")).toBeNull();
    expect(await findEscrowByIdempotencyKey("nope")).toBeNull();
  });
});
