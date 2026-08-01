import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createBudgetGroup, createTransaction, createWallet, getStore } from "@/core/store";
import { computeForecast, forecastAll, groupBurn, periodStart, spendSince, txTime } from "@/core/budget";
import type { Transaction, WalletPolicy } from "@/core/types";

const DAY = 24 * 60 * 60 * 1000;

const baseWalletPolicy: WalletPolicy = {
  maxPerTx: 200,
  dailyLimit: 2000,
  monthlyLimit: 20000,
  velocityLimitPerMin: 20,
  allowlist: [],
};

function settledTx(partial: Partial<Transaction> & { walletId: string; amount: number; requestedAt: number }): Transaction {
  return {
    id: "tx-" + Math.random().toString(36).slice(2),
    from: "acme:seed",
    to: "vendor:demo",
    purpose: "forecast-test",
    status: "SETTLED",
    settledAt: partial.requestedAt,
    nonce: "n-" + Math.random().toString(36).slice(2),
    ...partial,
  } as Transaction;
}

let walletSeq = 0;

beforeAll(async () => {
  await getStore().ready;
});

afterEach(async () => {
  const s = getStore();
  await s.ready;
  await s.client.execute("DELETE FROM budget_group_wallets");
  await s.client.execute("DELETE FROM budget_groups");
  await s.client.execute("DELETE FROM transactions WHERE wallet_id LIKE 'wallet-bd-%'");
  await s.client.execute("DELETE FROM wallets WHERE id LIKE 'wallet-bd-%'");
});

describe("budget forecast math (E3)", () => {
  it("returns no runway when there has been no spend", () => {
    const now = Date.now();
    const f = computeForecast({ limit: 2000, spend: 0, periodStartMs: now - 15 * DAY, now });
    expect(f.burnPct).toBe(0);
    expect(f.ratePerDay).toBe(0);
    expect(f.runwayDays).toBeNull();
    expect(f.projectedPct).toBe(0);
    expect(f.status).toBe("on_track");
  });

  it("projects runway from the current rate (half the limit spent over 15 days = 45 days left)", () => {
    const now = Date.now();
    const f = computeForecast({ limit: 4000, spend: 1000, periodStartMs: now - 15 * DAY, now });
    expect(f.ratePerDay).toBeCloseTo(1000 / 15, 5);
    expect(f.runwayDays).toBeCloseTo(45, 5);
    expect(f.burnPct).toBeCloseTo(0.25, 5);
    expect(f.status).toBe("on_track");
  });

  it("flags warning when the projected 30-day utilization crosses 80%", () => {
    const now = Date.now();
    const f = computeForecast({ limit: 1000, spend: 500, periodStartMs: now - 5 * DAY, now });
    expect(f.ratePerDay).toBeCloseTo(100, 5);
    expect(f.projectedPct).toBe(1);
    expect(f.status).toBe("warning");
  });

  it("marks a group exhausted once spend meets the limit", () => {
    const now = Date.now();
    const f = computeForecast({ limit: 1000, spend: 1000, periodStartMs: now - 10 * DAY, now });
    expect(f.burnPct).toBe(1);
    expect(f.runwayDays).toBe(0);
    expect(f.status).toBe("exhausted");
  });

  it("counts settled spend at settle time and pending at request time", () => {
    const now = Date.now();
    const txs = [
      settledTx({ walletId: "w1", amount: 100, requestedAt: now - 10 * DAY }),
      settledTx({ walletId: "w1", amount: 50, requestedAt: now - 5 * DAY }),
    ];
    expect(spendSince(txs, now - 30 * DAY)).toBe(150);
    expect(txTime(txs[0])).toBe(now - 10 * DAY);
    const pending = { ...txs[0], status: "PENDING" as const, settledAt: undefined };
    expect(txTime(pending)).toBe(now - 10 * DAY);
  });
});

describe("budget forecast integration (E3)", () => {
  it("computes a burn-down series and runway from real stored transactions", async () => {
    const now = Date.now();
    const wallet = await createWallet({
      id: `wallet-bd-${++walletSeq}`,
      name: "Burn Bot",
      ownerDid: "did:org:bd",
      balance: 10000,
      policy: baseWalletPolicy,
    });
    const group = await createBudgetGroup({
      name: "Eng budget",
      monthlyLimit: 2000,
      walletIds: [wallet.id],
    });

    await createTransaction({
      walletId: wallet.id,
      from: "acme",
      to: "vendor:1",
      amount: 300,
      purpose: "infra",
      status: "SETTLED",
      requestedAt: now - 6 * DAY,
      settledAt: now - 6 * DAY,
      nonce: "bd-1",
    });
    await createTransaction({
      walletId: wallet.id,
      from: "acme",
      to: "vendor:2",
      amount: 200,
      purpose: "infra",
      status: "SETTLED",
      requestedAt: now - 1 * DAY,
      settledAt: now - 1 * DAY,
      nonce: "bd-2",
    });

    const txs = await (await import("@/core/store")).listTransactions();
    const burns = forecastAll([group], txs, now);
    const b = burns[0];

    expect(b.groupId).toBe(group.id);
    expect(b.spend).toBe(500);
    expect(b.burnPct).toBeCloseTo(0.25, 5);
    expect(b.ratePerDay).toBeCloseTo(500 / 6, 5);
    expect(b.runwayDays).toBeCloseTo(1500 / (500 / 6), 5);
    expect(b.walletCount).toBe(1);
    expect(b.series).toHaveLength(7);
    expect(b.series[6].spend).toBe(500);
    expect(b.series[6].limit).toBe(2000);
    expect(b.series[0].spend).toBe(300);
  });

  it("uses earliest activity as the burn-rate basis, not the full 30 days", async () => {
    const now = Date.now();
    const wallet = await createWallet({
      id: `wallet-bd-${++walletSeq}`,
      name: "Burst Bot",
      ownerDid: "did:org:bd",
      balance: 10000,
      policy: baseWalletPolicy,
    });
    const group = await createBudgetGroup({ name: "New group", monthlyLimit: 2000, walletIds: [wallet.id] });

    await createTransaction({
      walletId: wallet.id,
      from: "acme",
      to: "vendor:3",
      amount: 1000,
      purpose: "burst",
      status: "SETTLED",
      requestedAt: now - 2 * DAY,
      settledAt: now - 2 * DAY,
      nonce: "bd-3",
    });

    const txs = await (await import("@/core/store")).listTransactions();
    const start = periodStart(group, txs, now);
    expect(start).toBeGreaterThan(now - 3 * DAY);
    const b = groupBurn(group, txs, now);
    expect(b.ratePerDay).toBeCloseTo(500, 5);
    expect(b.runwayDays).toBeCloseTo(2, 5);
  });
});
