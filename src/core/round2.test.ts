import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { runDeposit, runRecurringDue, runTransfer, runWithdrawal } from "@/core/executor";
import {
  acknowledgeOutbox,
  approveApproval,
  createRecurringSchedule,
  createTransaction,
  createWallet,
  ensureDefaultSigners,
  escalateStepUps,
  getRecurringSchedule,
  getStore,
  getWallet,
  listOutbox,
  listRecurringSchedules,
  promoteDuePolicies,
  setGlobalKillSwitch,
  updatePolicy,
} from "@/core/store";
import { detectStructuring } from "@/core/structuring";
import { buildTimeline, latencyPercentiles } from "@/core/timeline";
import { packSha256, signExportPack, verifyExportPack } from "@/core/export-proof";
import type { Transaction, WalletPolicy } from "@/core/types";

const baseWalletPolicy: WalletPolicy = {
  maxPerTx: 1000,
  dailyLimit: 10000,
  monthlyLimit: 100000,
  velocityLimitPerMin: 50,
  allowlist: ["vendor:acme", "compute:0xCAFE0001"],
};

let seq = 0;

async function makeWallet(over: Partial<WalletPolicy> = {}) {
  const id = `wallet-r2-${++seq}`;
  return createWallet({
    id,
    name: "Round2 Bot",
    ownerDid: "did:org:round2",
    balance: 10000,
    policy: { ...baseWalletPolicy, ...over },
  });
}

async function cleanup() {
  const s = getStore();
  await s.ready;
  await s.client.execute("DELETE FROM transactions WHERE wallet_id LIKE 'wallet-r2-%'");
  await s.client.execute("DELETE FROM outbox WHERE wallet_id LIKE 'wallet-r2-%'");
  await s.client.execute("DELETE FROM recurring_schedules WHERE wallet_id LIKE 'wallet-r2-%'");
  await s.client.execute("DELETE FROM policy_versions WHERE wallet_id LIKE 'wallet-r2-%'");
  await s.client.execute("DELETE FROM approvals WHERE wallet_id LIKE 'wallet-r2-%'");
  await s.client.execute("DELETE FROM wallets WHERE id LIKE 'wallet-r2-%'");
}

beforeAll(async () => {
  await getStore().ready;
});

afterEach(async () => {
  await cleanup();
  await setGlobalKillSwitch("test teardown", false);
});

describe("executor: single transfers (E1)", () => {
  it("routes a low-risk transfer into the holding window as PENDING", async () => {
    const wallet = await makeWallet();
    const res = await runTransfer({
      walletId: wallet.id,
      to: "vendor:acme",
      amount: 25,
      purpose: "gpu burst",
      nonce: randomUUID(),
    });
    expect(res.status).toBe(201);
    const body = res.body as { status: string; transaction: Transaction; score: number };
    expect(body.status).toBe("PENDING");
    expect(body.score).toBeLessThan(55);
    expect(body.transaction.status).toBe("PENDING");
    expect(body.transaction.kind).toBe("transfer");
  });

  it("replays an idempotency key instead of double-settling", async () => {
    const wallet = await makeWallet();
    const key = `idem-${randomUUID()}`;
    const first = await runTransfer({
      walletId: wallet.id,
      to: "vendor:acme",
      amount: 25,
      purpose: "retry me",
      nonce: randomUUID(),
      idempotencyKey: key,
    });
    expect(first.status).toBe(201);
    const second = await runTransfer({
      walletId: wallet.id,
      to: "vendor:acme",
      amount: 25,
      purpose: "retry me",
      nonce: randomUUID(),
      idempotencyKey: key,
    });
    expect(second.status).toBe(200);
    expect((second.body as { replayed: boolean }).replayed).toBe(true);
  });

  it("blocks the whole fleet while a global kill switch is engaged", async () => {
    const wallet = await makeWallet();
    await setGlobalKillSwitch("emergency — market-wide freeze", true);
    const res = await runTransfer({
      walletId: wallet.id,
      to: "vendor:acme",
      amount: 25,
      purpose: "blocked by switch",
      nonce: randomUUID(),
    });
    expect(res.status).toBe(403);
    expect((res.body as { reason: string }).reason).toBe("ORGANIZATION_FROZEN");
    expect((res.body as { status: string }).status).toBe("BLOCKED");
  });
});

describe("executor: simulated funding (F1)", () => {
  it("deposits credit the ledger with a bank-style ref and simulated flag", async () => {
    const wallet = await makeWallet();
    const res = await runDeposit({ walletId: wallet.id, amount: 500, method: "wire" });
    expect(res.status).toBe(201);
    const body = res.body as {
      simulated: boolean;
      externalRef: string;
      newBalance: number;
      transaction: Transaction;
    };
    expect(body.simulated).toBe(true);
    expect(body.externalRef).toMatch(/^ach:\/\/credit\//);
    expect(body.newBalance).toBe(10500);
    expect(body.transaction.kind).toBe("deposit");
    expect(body.transaction.status).toBe("SETTLED");
  });

  it("withdrawals debit the ledger, still simulated", async () => {
    const wallet = await makeWallet();
    await runDeposit({ walletId: wallet.id, amount: 500, method: "wire" });
    const res = await runWithdrawal({ walletId: wallet.id, amount: 200, destination: "acct-1234" });
    expect(res.status).toBe(201);
    const body = res.body as { simulated: boolean; externalRef: string; newBalance: number };
    expect(body.simulated).toBe(true);
    expect(body.externalRef).toMatch(/^ach:\/\/debit\//);
    expect(body.newBalance).toBe(10300);
  });

  it("refuses an overdraft withdrawal", async () => {
    const wallet = await makeWallet();
    const res = await runWithdrawal({ walletId: wallet.id, amount: 999999, destination: "acct-1234" });
    expect(res.status).toBe(403);
    expect((res.body as { reason: string }).reason).toBe("INSUFFICIENT_FUNDS");
  });
});

describe("recurring schedules (F2)", () => {
  it("runs a due schedule through the guard and advances it", async () => {
    const wallet = await makeWallet();
    const schedule = await createRecurringSchedule({
      walletId: wallet.id,
      to: "compute:0xCAFE0001",
      amount: 15,
      purpose: "recurring-gpu",
      everyHours: 1,
    });
    const s = getStore();
    await s.ready;
    await s.client.execute("UPDATE recurring_schedules SET next_run_at = ? WHERE id = ?", [
      Date.now() - 1000,
      schedule.id,
    ]);

    const res = await runRecurringDue(Date.now());
    expect(res.ran).toBe(1);
    expect(res.results[0].status).toBe("PENDING");
    expect(res.results[0].scheduleId).toBe(schedule.id);

    const after = await getRecurringSchedule(schedule.id);
    expect(after!.nextRunAt).toBeGreaterThan(Date.now() - 1000);
    expect(after!.runCount).toBeGreaterThan(0);
    expect((await listRecurringSchedules(wallet.id)).length).toBe(1);
  });
});

describe("structuring detection (F5)", () => {
  it("flags many small same-beneficiary payments that jointly breach a cap", () => {
    const now = Date.now();
    const txs: Transaction[] = Array.from({ length: 6 }, (_, i) => ({
      id: `tx-s-${i}`,
      walletId: "wallet-r2-x",
      from: "wallet-r2-x",
      to: "vendor:splits",
      amount: 20,
      purpose: "fees",
      status: "SETTLED",
      requestedAt: now - (5 - i) * 60_000,
      settledAt: now - (5 - i) * 60_000,
      nonce: `n-${i}`,
    }));
    const clusters = detectStructuring(txs, now);
    const flagged = clusters.find((c) => c.flagged);
    expect(flagged).toBeDefined();
    expect(flagged!.count).toBe(6);
    expect(flagged!.totalUsd).toBe(120);
    expect(flagged!.jointThreshold).toBe(100);
  });

  it("does not flag a single lump payment", () => {
    const now = Date.now();
    const txs: Transaction[] = [
      {
        id: "tx-l-0",
        walletId: "wallet-r2-x",
        from: "wallet-r2-x",
        to: "vendor:onebig",
        amount: 120,
        purpose: "invoice",
        status: "SETTLED",
        requestedAt: now,
        settledAt: now,
        nonce: "n-l-0",
      },
    ];
    expect(detectStructuring(txs, now).every((c) => !c.flagged)).toBe(true);
  });

  it("emits an outbox STRUCTURING_ALERT for a flagged cluster", async () => {
    const wallet = await makeWallet();
    const now = Date.now();
    for (let i = 0; i < 6; i++) {
      await createTransaction({
        walletId: wallet.id,
        from: wallet.id,
        to: "vendor:splits",
        amount: 20,
        purpose: "fees",
        status: "SETTLED",
        requestedAt: now - (5 - i) * 60_000,
        settledAt: now - (5 - i) * 60_000,
        nonce: randomUUID(),
      });
    }
    const { listTransactions } = await import("@/core/store");
    const history = await listTransactions(wallet.id);
    const { emitStructuringAlerts } = await import("@/core/store");
    const emitted = await emitStructuringAlerts(history, now);
    expect(emitted).toBeGreaterThanOrEqual(1);
    const outbox = await listOutbox(wallet.id);
    expect(outbox.some((e) => e.eventType === "STRUCTURING_ALERT")).toBe(true);
  });
});

describe("threshold alerts (F5)", () => {
  it("emits a budget-threshold warning and dedupes within a day", async () => {
    const wallet = await makeWallet();
    const { emitThresholdAlert } = await import("@/core/store");
    await emitThresholdAlert({
      walletId: wallet.id,
      limitKind: "daily",
      threshold: "p80",
      limit: 1000,
      spent: 900,
    });
    await emitThresholdAlert({
      walletId: wallet.id,
      limitKind: "daily",
      threshold: "p80",
      limit: 1000,
      spent: 900,
    });
    const outbox = (await listOutbox(wallet.id)).filter(
      (e) => e.eventType === "BUDGET_THRESHOLD_WARNING",
    );
    const withDedupeKey = outbox.filter((e) => {
      try {
        return Boolean((JSON.parse(e.payload) as { dedupeKey?: string }).dedupeKey);
      } catch {
        return false;
      }
    });
    expect(withDedupeKey.length).toBe(1);
  });
});

describe("policy changes with 2-of-3 approval (F3)", () => {
  it("does not apply an approval-gated change until signers approve and the timelock elapses", async () => {
    const wallet = await makeWallet({ maxPerTx: 1000 });
    const change = await updatePolicy(wallet.id, { maxPerTx: 5000 }, "owner", {
      requireApproval: true,
    });
    expect(change!.approval).toBeDefined();
    expect(change!.approval!.operation).toBe("POLICY_CHANGE");
    expect(change!.approval!.status).toBe("PENDING");
    expect(change!.approval!.keyMinted).toBeFalsy();

    let current = await getWallet(wallet.id);
    expect(current!.policy.maxPerTx).toBe(1000);

    const signers = await ensureDefaultSigners();
    const one = await approveApproval(change!.approval!.id, signers[0].id);
    expect(one.approval.status).toBe("PENDING");
    expect(one.mintedKey).toBeUndefined();

    const two = await approveApproval(change!.approval!.id, signers[1].id);
    expect(two.approval.status).toBe("APPROVED");
    expect(two.mintedKey).toBeUndefined();

    await promoteDuePolicies(Date.now() + 70_000);
    current = await getWallet(wallet.id);
    expect(current!.policy.maxPerTx).toBe(5000);
  });

  it("applies a normal change without an approval", async () => {
    const wallet = await makeWallet({ maxPerTx: 1000 });
    await updatePolicy(wallet.id, { maxPerTx: 5000 }, "owner");
    await promoteDuePolicies(Date.now() + 70_000);
    const current = await getWallet(wallet.id);
    expect(current!.policy.maxPerTx).toBe(5000);
  });
});

describe("alert acknowledgment + escalation (F4/F6)", () => {
  it("acknowledges an outbox alert with who + why, audited", async () => {
    const wallet = await makeWallet();
    await runTransfer({
      walletId: wallet.id,
      to: "vendor:acme",
      amount: 25,
      purpose: "ack test",
      nonce: randomUUID(),
    });
    const outbox = await listOutbox(wallet.id);
    const entry = outbox.find((e) => e.eventType === "TX_REQUESTED")!;
    expect(entry).toBeDefined();

    const acked = await acknowledgeOutbox(entry.id, "owner-view", "reviewed the alert");
    expect(acked!.ackedAt).toBeGreaterThan(0);
    expect(acked!.ackedBy).toBe("owner-view");
    expect(acked!.ackNote).toBe("reviewed the alert");
  });

  it("escalates step-ups that are within the decision grace window", async () => {
    const wallet = await makeWallet();
    const now = Date.now();
    const tx = await createTransaction({
      walletId: wallet.id,
      from: wallet.id,
      to: "vendor:highrisk",
      amount: 800,
      purpose: "big order",
      status: "STEP_UP_REQUIRED",
      requestedAt: now - 110_000,
      pendingUntil: now + 1000,
      nonce: randomUUID(),
      stepUpScore: 70,
    });
    const escalated = await escalateStepUps(now);
    expect(escalated).toContain(tx.id);
    const outbox = await listOutbox(wallet.id);
    const entry = outbox.find((e) => {
      if (e.eventType !== "STEP_UP_ESCALATED") return false;
      try {
        return (JSON.parse(e.payload) as { txId?: string }).txId === tx.id;
      } catch {
        return false;
      }
    });
    expect(entry).toBeDefined();
    expect(JSON.parse(entry!.payload)).toMatchObject({ txId: tx.id });
  });
});

describe("signed export proof (F7)", () => {
  it("signs and verifies a regulator pack; tampering fails", () => {
    const pack = JSON.stringify({ ledgerHead: "0xabc", rows: 12, at: Date.now() });
    const sig = signExportPack(pack);
    expect(verifyExportPack(pack, sig)).toBe(true);
    expect(verifyExportPack(pack + "x", sig)).toBe(false);
    const wrongSig = signExportPack(pack + "different content");
    expect(verifyExportPack(pack, wrongSig)).toBe(false);
    expect(packSha256(pack)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("transaction timeline (F8)", () => {
  it("builds hops + latency for a settled transfer", () => {
    const tx: Transaction = {
      id: "tx-tl-1",
      walletId: "wallet-r2-x",
      from: "wallet-r2-x",
      to: "vendor:acme",
      amount: 25,
      purpose: "tl",
      status: "SETTLED",
      requestedAt: 1000,
      pendingUntil: 4000,
      settledAt: 6000,
      nonce: "n-tl",
      externalRef: "ach://credit/ref",
    };
    const tl = buildTimeline(tx);
    expect(tl.hops.map((h) => h.label)).toEqual(["REQUESTED", "HOLD_WINDOW", "SETTLED"]);
    expect(tl.latencyMs).toBe(5000);
    expect(tl.outcome).toBe("SETTLED");
  });

  it("records a BLOCKED hop when the guard rejects", () => {
    const tx: Transaction = {
      id: "tx-tl-2",
      walletId: "wallet-r2-x",
      from: "wallet-r2-x",
      to: "vendor:acme",
      amount: 999999,
      purpose: "tl",
      status: "BLOCKED",
      rejectionReason: "LIMIT_EXCEEDED",
      requestedAt: 1000,
      blockedAt: 1000,
      nonce: "n-tl2",
    };
    expect(buildTimeline(tx).hops.map((h) => h.label)).toContain("BLOCKED");
  });

  it("computes p50/p95 latencies over settled samples", () => {
    const txs: Transaction[] = [
      settled("a", 1000, 2000),
      settled("b", 1000, 4000),
      settled("c", 1000, 6000),
      settled("d", 1000, 8000),
    ];
    const m = latencyPercentiles(txs, 1000);
    expect(m.samples).toBe(4);
    expect(m.p50).toBe(5000);
    expect(m.p95).toBe(7000);
  });
});

function settled(id: string, requestedAt: number, settledAt: number): Transaction {
  return {
    id,
    walletId: "wallet-r2-x",
    from: "wallet-r2-x",
    to: "vendor:acme",
    amount: 10,
    purpose: "m",
    status: "SETTLED",
    requestedAt,
    settledAt,
    nonce: `n-${id}`,
  };
}
