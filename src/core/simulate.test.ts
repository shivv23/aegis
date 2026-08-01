import { describe, expect, it } from "vitest";
import { simulatePolicy } from "@/core/simulate";
import type { Transaction, WalletPolicy } from "@/core/types";
import { SEED_WALLET_ID } from "@/core/seed";

const base: WalletPolicy = {
  maxPerTx: 100,
  dailyLimit: 1000,
  monthlyLimit: 5000,
  velocityLimitPerMin: 30,
  allowlist: ["compute:0xCAFE0001", "api:0xBEEF0002", "drain:0xBADBEEF"],
};

function tx(partial: Partial<Transaction> & { id: string; to: string; amount: number; requestedAt: number }): Transaction {
  const base = {
    walletId: SEED_WALLET_ID,
    from: SEED_WALLET_ID,
    purpose: "test",
    status: "SETTLED",
    nonce: `n-${partial.id}`,
    ...partial,
  };
  return {
    ...base,
    settledAt: base.status === "SETTLED" ? base.requestedAt : undefined,
  } as Transaction;
}

describe("what-if policy simulator", () => {
  it("reports would-be blocks under a tighter policy", () => {
    const history = [
      tx({ id: "a", to: "compute:0xCAFE0001", amount: 300, requestedAt: 1000, status: "SETTLED" }),
      tx({ id: "b", to: "compute:0xCAFE0001", amount: 20, requestedAt: 2000, status: "SETTLED" }),
      tx({ id: "c", to: "drain:0xBADBEEF", amount: 50, requestedAt: 3000, status: "SETTLED" }),
    ];
    const result = simulatePolicy(base, history);
    // 300 > maxPerTx 100 → blocked under the hypothetical policy.
    expect(result.decisions.find((d) => d.txId === "a")!.wouldBe).toBe("BLOCKED");
    expect(result.summary.newlyBlocked).toBe(1);
    expect(result.summary.wouldSettle).toBe(2);
  });

  it("accumulates limits with reservation semantics", () => {
    // Ten per-tx-cap payments exhaust the daily budget; the eleventh fails
    // even though every individual payment is legal.
    const history = Array.from({ length: 12 }, (_, i) =>
      tx({
        id: `a${i}`,
        to: "api:0xBEEF0002",
        amount: 100,
        requestedAt: 1000 + i * 100,
      }),
    );
    const result = simulatePolicy(base, history);
    expect(result.decisions[0].wouldBe).toBe("ALLOWED");
    expect(result.decisions[9].wouldBe).toBe("ALLOWED");
    expect(result.decisions[10].wouldBe).toBe("BLOCKED");
    expect(result.decisions[10].reason).toBe("LIMIT_EXCEEDED");
    expect(result.summary.wouldSettle).toBe(10);
  });

  it("is read-only: no transactions are created", () => {
    const history = [
      tx({ id: "a", to: "compute:0xCAFE0001", amount: 500, requestedAt: 1000 }),
    ];
    const result = simulatePolicy(base, history);
    expect(result.summary.total).toBe(1);
    expect(result.summary.wouldBlock).toBe(1);
  });
});
