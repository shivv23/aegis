import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  BREAKER_THRESHOLD,
  approveStepUp,
  createTransaction,
  declineStepUp,
  expireStepUps,
  getBreakerState,
  getStore,
  getTransaction,
  getWallet,
  recordAnomaly,
  settleDue,
} from "@/core/store";
import { SEED_WALLET_ID } from "@/core/seed";
import { canTransition } from "@/core/stateMachine";

beforeAll(async () => {
  await getStore().ready;
});

function stepUpTx(overrides: { to?: string; pendingUntil?: number } = {}) {
  return createTransaction({
    walletId: SEED_WALLET_ID,
    from: SEED_WALLET_ID,
    to: overrides.to ?? "compute:0xCAFE0001",
    amount: 90,
    purpose: "emergency drain",
    status: "STEP_UP_REQUIRED",
    requestedAt: Date.now(),
    pendingUntil: overrides.pendingUntil ?? Date.now() + 120000,
    nonce: randomUUID(),
    stepUpScore: 78,
  });
}

describe("step-up state machine", () => {
  it("allows STEP_UP_REQUIRED → PENDING → SETTLED", () => {
    expect(canTransition("STEP_UP_REQUIRED", "PENDING")).toBe(true);
    expect(canTransition("STEP_UP_REQUIRED", "BLOCKED")).toBe(true);
    expect(canTransition("PENDING", "STEP_UP_REQUIRED")).toBe(false);
  });

  it("approve moves a high-risk transfer into the holding window and settles it", async () => {
    const tx = await stepUpTx();
    const approved = await approveStepUp(tx.id);
    expect(approved!.tx.status).toBe("PENDING");
    expect(approved!.tx.pendingUntil).toBeGreaterThan(Date.now());

    const settled = await settleDue(Date.now() + 60000);
    expect(settled.some((t) => t.id === tx.id)).toBe(true);

    const final = await getTransaction(tx.id);
    expect(final!.status).toBe("SETTLED");
  });

  it("decline blocks a high-risk transfer", async () => {
    const tx = await stepUpTx();
    const declined = await declineStepUp(tx.id);
    expect(declined!.status).toBe("BLOCKED");
    expect(declined!.rejectionReason).toBe("STEP_UP_DECLINED");
  });

  it("expires step-ups that outlive their decision window", async () => {
    const tx = await stepUpTx({ pendingUntil: Date.now() - 1 });
    const expired = await expireStepUps();
    expect(expired).toContain(tx.id);
    const final = await getTransaction(tx.id);
    expect(final!.status).toBe("BLOCKED");
    expect(final!.rejectionReason).toBe("STEP_UP_EXPIRED");
  });

  it("cannot approve a transaction that is not awaiting step-up", async () => {
    const tx = await stepUpTx();
    await approveStepUp(tx.id);
    const again = await approveStepUp(tx.id);
    expect(again).toBeNull();
  });
});

describe("circuit breaker", () => {
  it("auto-freezes a wallet after the anomaly threshold is reached", async () => {
    const wallet = await getWallet(SEED_WALLET_ID);
    expect(wallet!.status).toBe("ACTIVE");

    for (let i = 0; i < BREAKER_THRESHOLD; i++) {
      await recordAnomaly(SEED_WALLET_ID, "TX_BLOCKED", `anomaly ${i}`);
    }

    expect(getBreakerState(SEED_WALLET_ID).tripped).toBe(true);
    expect(getBreakerState(SEED_WALLET_ID).anomalies).toBeGreaterThanOrEqual(BREAKER_THRESHOLD);

    const frozen = await getWallet(SEED_WALLET_ID);
    expect(frozen!.status).toBe("FROZEN");
  });
});
