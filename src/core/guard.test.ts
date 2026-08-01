import { describe, expect, it } from "vitest";
import {
  checkAllowlist,
  checkDailyLimit,
  checkFreeze,
  checkFunds,
  checkMonthlyLimit,
  checkPerTxLimit,
  checkVelocity,
  runGuard,
  spendContext,
} from "@/core/guard";
import { canTransition } from "@/core/stateMachine";
import type { Transaction, Wallet } from "@/core/types";

const baseWallet: Wallet = {
  id: "w1",
  name: "TestBot",
  ownerDid: "did:org:acme",
  status: "ACTIVE",
  balance: 5000,
  policy: {
    maxPerTx: 100,
    dailyLimit: 1000,
    monthlyLimit: 5000,
    velocityLimitPerMin: 5,
    allowlist: ["vendor:a", "vendor:b"],
  },
  createdAt: 0,
};

const emptyCtx = { spentLast24h: 0, spentLast30d: 0, txCountLastMin: 0 };

function settle(walletId: string, amount: number, ageMs: number): Transaction {
  return {
    id: Math.random().toString(36).slice(2),
    walletId,
    from: walletId,
    to: "vendor:a",
    amount,
    purpose: "test",
    status: "SETTLED",
    requestedAt: Date.now() - ageMs,
    settledAt: Date.now() - ageMs,
    nonce: Math.random().toString(36),
  };
}

describe("Policy Guard", () => {
  it("allows a compliant transfer", () => {
    const r = runGuard(baseWallet, 50, "vendor:a", emptyCtx);
    expect(r.allowed).toBe(true);
  });

  it("blocks transfers above the per-transaction cap", () => {
    const r = runGuard(baseWallet, 101, "vendor:a", emptyCtx);
    expect(r).toMatchObject({ allowed: false, reason: "LIMIT_EXCEEDED" });
  });

  it("blocks transfers to non-allowlisted counterparties", () => {
    const r = runGuard(baseWallet, 50, "attacker:x", emptyCtx);
    expect(r).toMatchObject({ allowed: false, reason: "NOT_ALLOWLISTED" });
  });

  it("blocks transfers when the wallet is frozen", () => {
    const frozen = { ...baseWallet, status: "FROZEN" as const };
    const r = runGuard(frozen, 1, "vendor:a", emptyCtx);
    expect(r).toMatchObject({ allowed: false, reason: "WALLET_FROZEN" });
  });

  it("blocks transfers that exceed the daily limit", () => {
    const ctx = { ...emptyCtx, spentLast24h: 950 };
    const r = runGuard(baseWallet, 100, "vendor:a", ctx);
    expect(r).toMatchObject({ allowed: false, reason: "LIMIT_EXCEEDED" });
  });

  it("allows transfers exactly at the daily limit boundary", () => {
    const ctx = { ...emptyCtx, spentLast24h: 900 };
    const r = runGuard(baseWallet, 100, "vendor:a", ctx);
    expect(r.allowed).toBe(true);
  });

  it("blocks transfers that exceed the monthly limit", () => {
    const ctx = { ...emptyCtx, spentLast30d: 4950 };
    const r = runGuard(baseWallet, 100, "vendor:a", ctx);
    expect(r).toMatchObject({ allowed: false, reason: "LIMIT_EXCEEDED" });
  });

  it("blocks transfers beyond the velocity limit", () => {
    const ctx = { ...emptyCtx, txCountLastMin: 5 };
    const r = runGuard(baseWallet, 10, "vendor:a", ctx);
    expect(r).toMatchObject({ allowed: false, reason: "VELOCITY_EXCEEDED" });
  });

  it("blocks transfers that exceed the available balance", () => {
    const poor = { ...baseWallet, balance: 30 };
    const r = runGuard(poor, 50, "vendor:a", emptyCtx);
    expect(r).toMatchObject({ allowed: false, reason: "INSUFFICIENT_FUNDS" });
  });

  it("returns the first violation when multiple rules trip", () => {
    const ctx = { ...emptyCtx, spentLast24h: 99999 };
    const r = runGuard(baseWallet, 5000, "attacker:x", ctx);
    expect(r).toMatchObject({ allowed: false, reason: "LIMIT_EXCEEDED" });
  });
});

describe("Attack resistance", () => {
  it("a stolen agent key cannot exceed policy by splitting payments", () => {
    // attacker tries 12 x $90 = $1080 in a day against $1000 daily limit
    let spent = 0;
    for (let i = 0; i < 12; i++) {
      const ctx = { ...emptyCtx, spentLast24h: spent };
      const r = runGuard(baseWallet, 90, "vendor:a", ctx);
      if (r.allowed) spent += 90;
      else break;
    }
    expect(spent).toBeLessThanOrEqual(1000);
  });

  it("a stolen agent key cannot pay unlisted parties even within limits", () => {
    const r = runGuard(baseWallet, 10, "unknown:drain", emptyCtx);
    expect(r.allowed).toBe(false);
  });

  it("velocity caps a burst attack even when each tx is individually legal", () => {
    let allowed = 0;
    for (let i = 0; i < 20; i++) {
      const ctx = { ...emptyCtx, txCountLastMin: allowed };
      const r = runGuard(baseWallet, 1, "vendor:a", ctx);
      if (r.allowed) allowed++;
    }
    expect(allowed).toBeLessThanOrEqual(5);
  });

  it("a frozen wallet blocks even a $0.01 transfer", () => {
    const frozen = { ...baseWallet, status: "FROZEN" as const };
    const r = runGuard(frozen, 0.01, "vendor:a", emptyCtx);
    expect(r.allowed).toBe(false);
  });
});

describe("spendContext", () => {
  it("computes rolling spend from settled history", () => {
    const history = [
      settle(baseWallet.id, 100, 50 * 1000),
      settle(baseWallet.id, 50, 3 * 60 * 60 * 1000),
      settle(baseWallet.id, 200, 40 * 24 * 60 * 60 * 1000),
    ];
    const ctx = spendContext(baseWallet.id, Date.now(), history);
    expect(ctx.spentLast24h).toBe(150);
    expect(ctx.spentLast30d).toBe(150);
    expect(ctx.txCountLastMin).toBe(1);
  });

  it("ignores blocked and revoked transactions but reserves pending ones", () => {
    const history: Transaction[] = [
      { ...settle(baseWallet.id, 100, 50 * 1000), status: "BLOCKED" },
      { ...settle(baseWallet.id, 100, 50 * 1000), status: "REVOKED" },
      {
        ...settle(baseWallet.id, 60, 50 * 1000),
        status: "PENDING",
        settledAt: undefined,
        pendingUntil: Date.now() + 5000,
      },
    ];
    const ctx = spendContext(baseWallet.id, Date.now(), history);
    expect(ctx.spentLast24h).toBe(60);
    expect(ctx.txCountLastMin).toBe(1);
  });

  it("a split attack cannot exceed the daily cap even before settlement", () => {
    // $100 per tx allowed, $1000 daily. Fire 12 x $90 as PENDING.
    const pending: Transaction[] = Array.from({ length: 12 }, (_, i) => ({
      ...settle(baseWallet.id, 90, 10 * 1000),
      status: "PENDING",
      settledAt: undefined,
      pendingUntil: Date.now() + 5000,
      purpose: `split ${i}`,
    }));
    const ctx = spendContext(baseWallet.id, Date.now(), pending);
    expect(ctx.spentLast24h).toBe(1080);
    const verdict = runGuard(baseWallet, 90, "vendor:a", ctx);
    expect(verdict).toMatchObject({ allowed: false, reason: "LIMIT_EXCEEDED" });
  });
});

describe("Transaction state machine", () => {
  it("allows PENDING -> SETTLED | REVOKED | BLOCKED", () => {
    expect(canTransition("PENDING", "SETTLED")).toBe(true);
    expect(canTransition("PENDING", "REVOKED")).toBe(true);
    expect(canTransition("PENDING", "BLOCKED")).toBe(true);
  });

  it("forbids illegal transitions", () => {
    expect(canTransition("SETTLED", "REVOKED")).toBe(false);
    expect(canTransition("REVOKED", "SETTLED")).toBe(false);
    expect(canTransition("BLOCKED", "PENDING")).toBe(false);
    expect(canTransition("SETTLED", "PENDING")).toBe(false);
  });
});

describe("Individual guard units", () => {
  it("checkPerTxLimit respects the cap", () => {
    expect(checkPerTxLimit(baseWallet, 100).allowed).toBe(true);
    expect(checkPerTxLimit(baseWallet, 100.01).allowed).toBe(false);
  });

  it("checkAllowlist is exact match", () => {
    expect(checkAllowlist(baseWallet, "vendor:b").allowed).toBe(true);
    expect(checkAllowlist(baseWallet, "vendor:b ").allowed).toBe(false);
  });

  it("checkFreeze reacts to status", () => {
    expect(checkFreeze(baseWallet).allowed).toBe(true);
    expect(checkFreeze({ ...baseWallet, status: "FROZEN" }).allowed).toBe(false);
  });

  it("checkFunds uses available balance", () => {
    expect(checkFunds(baseWallet, 5000).allowed).toBe(true);
    expect(checkFunds(baseWallet, 5000.01).allowed).toBe(false);
  });

  it("checkDailyLimit and checkMonthlyLimit bound cumulative spend", () => {
    expect(checkDailyLimit(baseWallet, 100, 1000).allowed).toBe(false);
    expect(checkMonthlyLimit(baseWallet, 100, 5000).allowed).toBe(false);
  });

  it("checkVelocity trips at the configured limit", () => {
    expect(checkVelocity(baseWallet, 4).allowed).toBe(true);
    expect(checkVelocity(baseWallet, 5).allowed).toBe(false);
  });
});
