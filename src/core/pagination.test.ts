import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTransaction, createWallet, getStore, listTransactionsPage } from "@/core/store";
import { clampLimit, decodeCursor, encodeCursor } from "@/core/pagination";
import type { WalletPolicy } from "@/core/types";

const DAY = 24 * 60 * 60 * 1000;

const baseWalletPolicy: WalletPolicy = {
  maxPerTx: 200,
  dailyLimit: 2000,
  monthlyLimit: 20000,
  velocityLimitPerMin: 20,
  allowlist: [],
};

let seq = 0;
let walletSeq = 0;

beforeAll(async () => {
  await getStore().ready;
});

afterEach(async () => {
  const s = getStore();
  await s.ready;
  await s.client.execute("DELETE FROM transactions WHERE wallet_id LIKE 'wallet-pg-%'");
  await s.client.execute("DELETE FROM wallets WHERE id LIKE 'wallet-pg-%'");
});

describe("cursor helpers (C1)", () => {
  it("round-trips a cursor", () => {
    const raw = encodeCursor(1780000000000, "tx-abc");
    const c = decodeCursor(raw);
    expect(c).toEqual({ at: 1780000000000, id: "tx-abc" });
  });

  it("rejects garbage and empty cursors", () => {
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor("not-a-cursor")).toBeNull();
    expect(decodeCursor("aGVsbG8=")).toBeNull();
  });

  it("clamps limit to the configured bounds", () => {
    expect(clampLimit(null)).toBe(100);
    expect(clampLimit("50")).toBe(50);
    expect(clampLimit("5000")).toBe(1000);
    expect(clampLimit("-3")).toBe(100);
    expect(clampLimit("abc")).toBe(100);
  });
});

describe("keyset pagination (C1)", () => {
  async function seedWallet() {
    return createWallet({ id: `wallet-pg-${++walletSeq}`, name: "Page Bot", ownerDid: "did:org:pg", balance: 100000, policy: baseWalletPolicy });
  }

  async function tx(walletId: string, amount: number, requestedAt: number, i: number) {
    await createTransaction({
      walletId,
      from: walletId,
      to: `vendor:page:${i}`,
      amount,
      purpose: "page-test",
      status: "SETTLED",
      requestedAt,
      settledAt: requestedAt,
      nonce: `page-${seq++}-${i}`,
    });
  }

  it("walks a full list with no overlap and no gaps", async () => {
    const w = await seedWallet();
    const base = Date.now() - 100 * DAY;
    for (let i = 0; i < 10; i++) {
      await tx(w.id, 10 + i, base + i * DAY, i);
    }

    const collected: number[] = [];
    let cursor: string | null = null;
    for (let round = 0; round < 5; round++) {
      const page = await listTransactionsPage({ walletId: w.id, limit: 3, cursor: cursor ? decodeCursor(cursor) : null });
      collected.push(...page.items.map((t) => t.amount));
      expect(page.items.length).toBeLessThanOrEqual(3);
      cursor = page.nextCursor;
      if (round === 0) expect(cursor).not.toBeNull();
      if (!cursor) break;
    }

    expect(collected).toEqual([19, 18, 17, 16, 15, 14, 13, 12, 11, 10]);
  });

  it("handles ties on the ordering column via the id tiebreak", async () => {
    const w = await seedWallet();
    const same = Date.now();
    for (let i = 0; i < 4; i++) {
      await tx(w.id, 100 + i, same, i);
    }

    const page1 = await listTransactionsPage({ walletId: w.id, limit: 2, cursor: null });
    const page2 = await listTransactionsPage({ walletId: w.id, limit: 2, cursor: decodeCursor(page1.nextCursor!) });
    expect(page1.items.length).toBe(2);
    expect(page2.items.length).toBe(2);
    const ids = [...page1.items, ...page2.items].map((t) => t.id);
    expect(new Set(ids).size).toBe(4);
  });

  it("scopes pages to a wallet", async () => {
    const w1 = await seedWallet();
    const w2 = await seedWallet();
    await tx(w1.id, 1, Date.now() - DAY, 0);
    await tx(w2.id, 2, Date.now() - DAY, 1);

    const page = await listTransactionsPage({ walletId: w1.id, limit: 10, cursor: null });
    expect(page.items).toHaveLength(1);
    expect(page.items[0].amount).toBe(1);
    expect(page.nextCursor).toBeNull();
  });

  it("returns no next cursor when everything fits in one page", async () => {
    const w = await seedWallet();
    await tx(w.id, 5, Date.now() - DAY, 0);
    const page = await listTransactionsPage({ walletId: w.id, limit: 100, cursor: null });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });
});
