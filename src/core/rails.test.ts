import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getRail, listRails } from "@/core/rails";
import {
  createTransaction,
  getStore,
  getTransaction,
  settleDue,
} from "@/core/store";
import { SEED_WALLET_ID } from "@/core/seed";

beforeAll(async () => {
  await getStore().ready;
});

describe("rail adapter", () => {
  it("exposes sandbox, usdc-testnet and ach-lite rails", () => {
    const ids = listRails().map((r) => r.id);
    expect(ids).toEqual(["sandbox", "usdc-testnet", "ach-lite"]);
  });

  it("defaults to the sandbox rail and settles with a local ref", async () => {
    expect(getRail().id).toBe("sandbox");
    const tx = await createTransaction({
      walletId: SEED_WALLET_ID,
      from: SEED_WALLET_ID,
      to: "compute:0xCAFE0001",
      amount: 5,
      purpose: "rail test",
      status: "PENDING",
      requestedAt: Date.now(),
      pendingUntil: Date.now() - 1,
      nonce: randomUUID(),
    });
    const settled = await settleDue(Date.now() + 1);
    expect(settled.some((t) => t.id === tx.id)).toBe(true);
    const final = await getTransaction(tx.id);
    expect(final!.status).toBe("SETTLED");
    expect(final!.externalRef).toMatch(/^local:\/\//);
  });

  it("produces a deterministic on-chain-style ref on the usdc-testnet rail", () => {
    const rail = getRail("usdc-testnet");
    const input = {
      txId: "t1",
      walletId: SEED_WALLET_ID,
      to: "compute:0xCAFE0001",
      amount: 25,
      amountUnits: "2500",
      purpose: "gpu",
      nonce: "n-1",
      requestedAt: 12345,
    };
    return rail.execute(input).then((a) =>
      rail.execute(input).then((b) => {
        expect(a.status).toBe("SETTLED");
        expect(a.externalRef).toBe(b.externalRef);
        expect(a.externalRef).toMatch(/^0x[0-9a-f]{40}$/);
      }),
    );
  });

  it("sandbox rail returns a zero integer fee", async () => {
    const rail = getRail("sandbox");
    const input = {
      txId: "t2",
      walletId: SEED_WALLET_ID,
      to: "compute:0xCAFE0001",
      amount: 10,
      amountUnits: "1000",
      purpose: "fee test",
      nonce: "n-2",
      requestedAt: 12346,
    };
    const result = await rail.execute(input);
    expect(result.feeUnits).toBe("0");
  });
});
