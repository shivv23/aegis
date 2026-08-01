import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createTransaction,
  getStore,
  getWallet,
  listTransactions,
  settleDue,
  saveReconciliationReport,
  setWalletPreferredRail,
  latestReconciliationReport,
} from "@/core/store";
import { getRail, railIsSimulated } from "@/core/rails";
import { reconcileSettledTransactions } from "@/core/reconcile";
import { SEED_WALLET_ID } from "@/core/seed";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AEGIS_CIRCLE_API_KEY;
  delete process.env.AEGIS_CIRCLE_SOURCE_ADDRESS;
});

describe("circle USDC rail (A2)", () => {
  it("settles via the Circle sandbox API and returns the transaction hash", async () => {
    process.env.AEGIS_CIRCLE_API_KEY = "Q2lyY2xl";
    process.env.AEGIS_CIRCLE_SOURCE_ADDRESS = "0xSOURCE1234";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { transactionHash: "0xcirclehash1234567890abcdef1234567890" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await getRail("usdc-testnet").execute({
      txId: "tx-1",
      walletId: SEED_WALLET_ID,
      to: "0xRECIPIENT",
      amount: 12.34,
      amountUnits: "1234",
      purpose: "circle test",
      nonce: randomUUID(),
      requestedAt: Date.now(),
    });

    expect(result.status).toBe("SETTLED");
    expect(result.externalRef).toBe("0xcirclehash1234567890abcdef1234567890");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.circle.com/v1/transfers");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer Q2lyY2xl");
  });

  it("marks usdc as simulated only when no gateway key is configured", () => {
    expect(railIsSimulated("usdc-testnet")).toBe(true);
    process.env.AEGIS_CIRCLE_API_KEY = "k";
    expect(railIsSimulated("usdc-testnet")).toBe(false);
  });
});

describe("reconciliation (A5)", () => {
  it("matches clean simulated settlements with no breaks", async () => {
    const rail = getRail("sandbox");
    const result = await rail.execute({
      txId: "tx-recon-1",
      walletId: SEED_WALLET_ID,
      to: "vendor:acme",
      amount: 42,
      amountUnits: "4200",
      purpose: "recon",
      nonce: "n-1",
      requestedAt: 1000,
    });
    const tx: Parameters<typeof reconcileSettledTransactions>[0][number] = {
      id: "tx-recon-1",
      walletId: SEED_WALLET_ID,
      from: "agent:0x",
      to: "vendor:acme",
      amount: 42,
      purpose: "recon",
      status: "SETTLED",
      requestedAt: 1000,
      nonce: "n-1",
      externalRef: result.externalRef,
      rail: "sandbox",
    };

    const report = await reconcileSettledTransactions([tx]);
    expect(report.total).toBe(1);
    expect(report.matched).toBe(1);
    expect(report.breaks).toBe(0);
  });

  it("flags a tampered external reference as a break", async () => {
    const tx: Parameters<typeof reconcileSettledTransactions>[0][number] = {
      id: "tx-recon-2",
      walletId: SEED_WALLET_ID,
      from: "agent:0x",
      to: "vendor:acme",
      amount: 10,
      purpose: "recon",
      status: "SETTLED",
      requestedAt: 1000,
      nonce: "n-2",
      externalRef: "local://different-tx",
      rail: "sandbox",
    };

    const report = await reconcileSettledTransactions([tx]);
    expect(report.breaks).toBe(1);
    expect(report.breaksList[0]?.kind).toBe("REF_MISMATCH");
  });

  it("flags missing references as breaks", async () => {
    const tx: Parameters<typeof reconcileSettledTransactions>[0][number] = {
      id: "tx-recon-3",
      walletId: SEED_WALLET_ID,
      from: "agent:0x",
      to: "vendor:acme",
      amount: 10,
      purpose: "recon",
      status: "SETTLED",
      requestedAt: 1000,
      nonce: "n-3",
      rail: "usdc-testnet",
    };

    const report = await reconcileSettledTransactions([tx]);
    expect(report.breaks).toBe(1);
    expect(report.breaksList[0]?.kind).toBe("MISSING_REF");
  });

  it("persists the latest report", async () => {
    const report = await reconcileSettledTransactions([]);
    await saveReconciliationReport(report);
    const latest = await latestReconciliationReport();
    expect(latest?.total).toBe(0);
    expect(latest?.id).toBe(report.id);
  });

  it("settles through the wallet's preferred rail and records it on the tx", async () => {
    await setWalletPreferredRail(SEED_WALLET_ID, "ach-lite");
    expect((await getWallet(SEED_WALLET_ID))?.preferredRail).toBe("ach-lite");

    await createTransaction({
      walletId: SEED_WALLET_ID,
      from: "agent:0x",
      to: "vendor:bank",
      amount: 5,
      purpose: "rail switch",
      status: "PENDING",
      nonce: randomUUID(),
      requestedAt: Date.now(),
      pendingUntil: Date.now() + 5,
    });

    await settleDue(Date.now() + 100);
    const txs = await listTransactions();
    const settled = txs.find((t) => t.to === "vendor:bank");
    expect(settled?.status).toBe("SETTLED");
    expect(settled?.rail).toBe("ach-lite");
    expect(settled?.externalRef).toMatch(/^ach:\/\//);
    await setWalletPreferredRail(SEED_WALLET_ID, "sandbox");
  });
});
