import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createTransaction,
  getStore,
  listUsage,
  listWallets,
  recordUsage,
  settleDue,
  setWalletPreferredRail,
} from "@/core/store";
import { computeFee, feeScheduleFor, generateInvoice, listInvoices } from "@/core/usage";
import { SEED_WALLET_ID } from "@/core/seed";

beforeAll(async () => {
  await getStore().ready;
});

afterEach(async () => {
  const s = getStore();
  await s.ready;
  await s.client.execute("DELETE FROM usage");
  await s.client.execute("DELETE FROM invoices");
  await s.client.execute("DELETE FROM invoice_lines");
  delete process.env.AEGIS_FEE_USDC_BPS;
  delete process.env.AEGIS_FEE_ACH_BPS;
  delete process.env.AEGIS_FEE_FLAT_MIN;
});

describe("fee schedule (A6)", () => {
  it("defaults: sandbox free, usdc 0.15%, ach 0.50%, $0.01 min", () => {
    expect(feeScheduleFor("sandbox")).toEqual({ bps: 0, minUsd: 0 });
    expect(feeScheduleFor("usdc-testnet")).toEqual({ bps: 15, minUsd: 0.01 });
    expect(feeScheduleFor("ach-lite")).toEqual({ bps: 50, minUsd: 0.01 });
  });

  it("is overridable via env and applies the flat minimum", () => {
    process.env.AEGIS_FEE_USDC_BPS = "250";
    process.env.AEGIS_FEE_ACH_BPS = "0";
    expect(computeFee("usdc-testnet", 100)).toBe(2.5);
    expect(computeFee("usdc-testnet", 1)).toBe(0.03);
    expect(computeFee("usdc-testnet", 0.01)).toBe(0.01);
    expect(computeFee("ach-lite", 1000)).toBe(0);
    expect(computeFee("sandbox", 999)).toBe(0);
  });

  it("rounds fees to cents", () => {
    expect(computeFee("usdc-testnet", 3.33)).toBe(0.01);
    expect(computeFee("ach-lite", 123.45)).toBe(0.62);
  });
});

describe("usage metering fees (A6)", () => {
  it("computes and persists a fee per usage row", async () => {
    await recordUsage({ walletId: SEED_WALLET_ID, txId: "tx-fee-1", amount: 100, rail: "ach-lite" });
    const rows = await listUsage(SEED_WALLET_ID);
    const row = rows.find((u) => u.txId === "tx-fee-1");
    expect(row?.fee).toBe(0.5);
  });

  it("settling through a paid rail meters a fee on the usage row", async () => {
    const wallet = (await listWallets()).find((w) => w.id === SEED_WALLET_ID)!;
    await setWalletPreferredRail(wallet.id, "ach-lite");
    const tx = await createTransaction({
      walletId: wallet.id,
      from: "agent:0x",
      to: "vendor:ach-bill",
      amount: 200,
      purpose: "billing test",
      status: "PENDING",
      nonce: "nonce-fee-settle",
      requestedAt: Date.now(),
      pendingUntil: Date.now() + 5,
      idempotencyKey: "idem-fee-settle",
    });
    await settleDue(Date.now() + 100);
    const rows = await listUsage(wallet.id);
    const row = rows.find((u) => u.txId === tx.id);
    expect(row).toBeTruthy();
    expect(row?.rail).toBe("ach-lite");
    expect(row?.fee).toBe(1); // 200 * 0.50%
  });
});

describe("invoice generation (A6)", () => {
  it("aggregates usage rows into per-rail invoice lines", async () => {
    const t0 = Date.now() - 60_000;
    await recordUsage({ walletId: SEED_WALLET_ID, txId: "inv-a1", amount: 100, rail: "ach-lite" });
    await recordUsage({ walletId: SEED_WALLET_ID, txId: "inv-a2", amount: 300, rail: "ach-lite" });
    await recordUsage({ walletId: SEED_WALLET_ID, txId: "inv-b1", amount: 50, rail: "usdc-testnet" });

    const invoice = await generateInvoice({
      walletId: SEED_WALLET_ID,
      periodStart: t0,
      periodEnd: Date.now() + 1000,
    });
    expect(invoice).toBeTruthy();
    expect(invoice!.status).toBe("draft");
    expect(invoice!.totalUsd).toBe(450);
    expect(invoice!.totalFeeUsd).toBe(2.08); // ach 2.00 + usdc 0.08
    expect(invoice!.lines).toHaveLength(2);
    const ach = invoice!.lines.find((l) => l.rail === "ach-lite")!;
    expect(ach.amountUsd).toBe(400);
    expect(ach.feeUsd).toBe(2);
    const usdc = invoice!.lines.find((l) => l.rail === "usdc-testnet")!;
    expect(usdc.feeUsd).toBe(0.08);
  });

  it("is idempotent for the exact period and returns no invoice when empty", async () => {
    const t0 = Date.now() - 10_000;
    const tEnd = Date.now() + 1000;
    await recordUsage({ walletId: SEED_WALLET_ID, txId: "inv-idem", amount: 10, rail: "ach-lite" });
    const a = await generateInvoice({ walletId: SEED_WALLET_ID, periodStart: t0, periodEnd: tEnd });
    const b = await generateInvoice({ walletId: SEED_WALLET_ID, periodStart: t0, periodEnd: tEnd });
    expect(a!.id).toBe(b!.id);
    expect((await listInvoices()).filter((i) => i.id === a!.id)).toHaveLength(1);

    const empty = await generateInvoice({
      walletId: SEED_WALLET_ID,
      periodStart: Date.now() - 50_000,
      periodEnd: Date.now() - 40_000,
    });
    expect(empty).toBeNull();
  });
});
