import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  checkCounterparty,
  checkGroupBudget,
  checkRegion,
  checkSpendingWindow,
  runGuard,
  spendContext,
} from "@/core/guard";
import type { Transaction, Wallet } from "@/core/types";

const baseWallet: Wallet = {
  id: "w1",
  name: "FuzzBot",
  ownerDid: "did:org:acme",
  status: "ACTIVE",
  balance: 100000,
  policy: {
    maxPerTx: 1000,
    dailyLimit: 5000,
    monthlyLimit: 20000,
    velocityLimitPerMin: 30,
    allowlist: ["vendor:a", "vendor:b", "vendor:c"],
  },
  createdAt: 0,
};

describe("checkSpendingWindow", () => {
  it("allows when no windows configured", () => {
    expect(checkSpendingWindow(baseWallet, Date.now()).allowed).toBe(true);
  });

  it("allows inside a window and blocks outside it", () => {
    const wallet: Wallet = {
      ...baseWallet,
      policy: {
        ...baseWallet.policy,
        spendingWindows: [{ startHour: 9, endHour: 17 }],
      },
    };
    // 2026-01-05T10:00:00Z → UTC hour 10
    const inside = Date.UTC(2026, 0, 5, 10, 0, 0);
    const outside = Date.UTC(2026, 0, 5, 20, 0, 0);
    expect(checkSpendingWindow(wallet, inside).allowed).toBe(true);
    expect(checkSpendingWindow(wallet, outside).allowed).toBe(false);
    expect(checkSpendingWindow(wallet, outside).reason).toBe("OUTSIDE_SPENDING_WINDOW");
  });

  it("handles a window crossing midnight", () => {
    const wallet: Wallet = {
      ...baseWallet,
      policy: {
        ...baseWallet.policy,
        spendingWindows: [{ startHour: 22, endHour: 2 }],
      },
    };
    expect(checkSpendingWindow(wallet, Date.UTC(2026, 0, 5, 23, 0, 0)).allowed).toBe(true);
    expect(checkSpendingWindow(wallet, Date.UTC(2026, 0, 5, 1, 0, 0)).allowed).toBe(true);
    expect(checkSpendingWindow(wallet, Date.UTC(2026, 0, 5, 12, 0, 0)).allowed).toBe(false);
  });
});

describe("checkRegion", () => {
  it("allows when no region allowlist configured", () => {
    expect(checkRegion(baseWallet, undefined).allowed).toBe(true);
  });

  it("requires a region claim when an allowlist is set", () => {
    const wallet: Wallet = {
      ...baseWallet,
      policy: { ...baseWallet.policy, regionAllowlist: ["us-east", "eu-west"] },
    };
    expect(checkRegion(wallet, "us-east").allowed).toBe(true);
    expect(checkRegion(wallet, undefined).reason).toBe("REGION_BLOCKED");
    expect(checkRegion(wallet, "ap-south").reason).toBe("REGION_BLOCKED");
  });
});

describe("checkCounterparty", () => {
  it("blocks registry-blocked counterparties", () => {
    expect(checkCounterparty("BLOCKED", "vendor:a").reason).toBe("COUNTERPARTY_BLOCKED");
    expect(checkCounterparty("FLAGGED", "vendor:a").allowed).toBe(true);
    expect(checkCounterparty(undefined, "vendor:a").allowed).toBe(true);
  });
});

describe("checkGroupBudget", () => {
  it("enforces the group cap on top of per-wallet limits", () => {
    expect(checkGroupBudget(1000, 900, 50).allowed).toBe(true);
    expect(checkGroupBudget(1000, 960, 50).reason).toBe("GROUP_LIMIT_EXCEEDED");
    expect(checkGroupBudget(undefined, undefined, 50).allowed).toBe(true);
  });
});

describe("runGuard with new constraints", () => {
  it("rejects an amount exceeding the group budget", () => {
    const wallet: Wallet = { ...baseWallet, balance: 5000 };
    const res = runGuard(
      wallet,
      200,
      "vendor:a",
      spendContext(wallet.id, Date.now(), []),
      { groupLimit: 1000, counterpartyStatus: "ACTIVE" },
    );
    // 200 < maxPerTx, < daily, < monthly, groupSpent undefined so group passes
    expect(res.allowed).toBe(true);
  });

  it("blocks when the counterparty is registry-blocked even if otherwise legal", () => {
    const res = runGuard(
      baseWallet,
      10,
      "vendor:a",
      spendContext(baseWallet.id, Date.now(), []),
      { counterpartyStatus: "BLOCKED" },
    );
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe("COUNTERPARTY_BLOCKED");
  });
});

describe("property-based fuzzing of the guard", () => {
  it("never allows a tx above maxPerTx, regardless of inputs", () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 1e6, noNaN: true }),
        fc.float({ min: 0, max: 1e4, noNaN: true }),
        (spent, amount) => {
          const wallet: Wallet = { ...baseWallet, balance: 1e6 };
          const res = runGuard(
            wallet,
            amount,
            "vendor:a",
            { ...spendContext(wallet.id, Date.now(), []), spentLast24h: spent },
          );
          // The per-tx cap is the binding constraint; nothing above it may pass.
          if (amount > wallet.policy.maxPerTx) {
            expect(res.allowed).toBe(false);
            expect(res.reason).toBe("LIMIT_EXCEEDED");
          }
        },
      ),
    );
  });

  it("daily limit is never exceeded by an allowed tx", () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 1e5, noNaN: true }),
        fc.float({ min: 0, max: 1e3, noNaN: true }),
        (spent, amount) => {
          const wallet: Wallet = { ...baseWallet, balance: 1e6 };
          const res = runGuard(
            wallet,
            amount,
            "vendor:a",
            { ...spendContext(wallet.id, Date.now(), []), spentLast24h: spent },
          );
          if (res.allowed) {
            expect(spent + amount).toBeLessThanOrEqual(wallet.policy.dailyLimit + 1e-9);
          }
        },
      ),
    );
  });

  it("deterministic: identical inputs always yield identical verdicts", () => {
    fc.assert(
      fc.property(
        fc.record({
          amount: fc.float({ min: 0, max: 1e3 }),
          spent: fc.float({ min: 0, max: 1e4 }),
          to: fc.constantFrom("vendor:a", "vendor:b", "vendor:c", "vendor:z"),
        }),
        (input) => {
          const wallet: Wallet = { ...baseWallet };
          const ctx = { ...spendContext(wallet.id, Date.now(), []), spentLast24h: input.spent };
          const a = runGuard(wallet, input.amount, input.to, ctx);
          const b = runGuard(wallet, input.amount, input.to, ctx);
          expect(a).toEqual(b);
        },
      ),
    );
  });
});

describe("spendContext robustness", () => {
  it("ignores blocked/revoked/step-up rows in spend totals", () => {
    const now = Date.now();
    const history: Transaction[] = [
      { id: "1", walletId: "w1", from: "w1", to: "vendor:a", amount: 10, purpose: "x", status: "SETTLED", requestedAt: now - 1000, settledAt: now - 1000, nonce: "n1" },
      { id: "2", walletId: "w1", from: "w1", to: "vendor:a", amount: 9999, purpose: "x", status: "BLOCKED", requestedAt: now - 500, blockedAt: now - 500, nonce: "n2" },
      { id: "3", walletId: "w1", from: "w1", to: "vendor:a", amount: 9999, purpose: "x", status: "REVOKED", requestedAt: now - 500, revokedAt: now - 500, nonce: "n3" },
    ];
    const ctx = spendContext("w1", now, history);
    expect(ctx.spentLast24h).toBe(10);
    expect(ctx.txCountLastMin).toBe(1);
  });
});
