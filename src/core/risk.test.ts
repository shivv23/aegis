import { describe, expect, it } from "vitest";
import {
  CRITICAL_THRESHOLD,
  STEP_UP_THRESHOLD,
  adjustScore,
  riskLevel,
  scoreTransfer,
} from "@/core/risk";
import type { Transaction, Wallet } from "@/core/types";
import { SEED_WALLET_ID } from "@/core/seed";

const KNOWN_PAYEE = "compute:0xCAFE0001";

const wallet: Wallet = {
  id: SEED_WALLET_ID,
  name: "TradingBot-42",
  ownerDid: "did:org:acme",
  status: "ACTIVE",
  balance: 5000,
  policy: {
    maxPerTx: 100,
    dailyLimit: 1000,
    monthlyLimit: 5000,
    velocityLimitPerMin: 30,
    allowlist: [KNOWN_PAYEE],
  },
  createdAt: 0,
};

/** A settled history with `spent` in the last 24h, all to the known payee. */
function history(now: number, spentLast24h: number): Transaction[] {
  const count = Math.max(1, Math.round(spentLast24h / 95));
  return Array.from({ length: count }, (_, i) => {
    const requestedAt = now - (i + 1) * 2 * 60 * 60 * 1000;
    return {
      id: `h${i}`,
      walletId: SEED_WALLET_ID,
      from: SEED_WALLET_ID,
      to: KNOWN_PAYEE,
      amount: 95,
      purpose: "gpu burst",
      status: "SETTLED",
      requestedAt,
      settledAt: requestedAt,
      nonce: `seed-n${i}`,
    } as Transaction;
  });
}

const noon = new Date("2026-08-01T12:00:00Z").getTime();
const night = new Date("2026-08-01T03:00:00Z").getTime();

describe("risk engine", () => {
  it("is deterministic: identical inputs yield identical scores", () => {
    const a = scoreTransfer({
      wallet,
      amount: 90,
      to: KNOWN_PAYEE,
      purpose: "gpu burst",
      history: history(noon, 0),
      now: noon,
    });
    const b = scoreTransfer({
      wallet,
      amount: 90,
      to: KNOWN_PAYEE,
      purpose: "gpu burst",
      history: history(noon, 0),
      now: noon,
    });
    expect(a).toEqual(b);
  });

  it("scores a small payment to a known payee as LOW", () => {
    const verdict = scoreTransfer({
      wallet,
      amount: 10,
      to: KNOWN_PAYEE,
      purpose: "gpu burst #150",
      history: history(noon, 0),
      now: noon,
    });
    expect(verdict.level).toBe("LOW");
    expect(verdict.score).toBeLessThan(STEP_UP_THRESHOLD);
  });

  it("flags an amount near the per-tx cap", () => {
    const verdict = scoreTransfer({
      wallet,
      amount: 95,
      to: KNOWN_PAYEE,
      purpose: "gpu burst #150",
      history: history(noon, 0),
      now: noon,
    });
    const capFactor = verdict.factors.find((f) => f.name === "amount_vs_cap");
    expect(capFactor!.points).toBeGreaterThan(20);
  });

  it("adds points for a new payee", () => {
    const known = scoreTransfer({
      wallet,
      amount: 50,
      to: KNOWN_PAYEE,
      purpose: "gpu burst",
      history: history(noon, 0),
      now: noon,
    });
    const fresh = scoreTransfer({
      wallet,
      amount: 50,
      to: "compute:0xNEW0001",
      purpose: "gpu burst",
      history: history(noon, 0),
      now: noon,
    });
    expect(fresh.score).toBeGreaterThan(known.score);
    expect(fresh.factors.some((f) => f.name === "new_payee")).toBe(true);
  });

  it("flags red-flag purposes and night transfers", () => {
    const verdict = scoreTransfer({
      wallet,
      amount: 80,
      to: "compute:0xNEW0001",
      purpose: "emergency drain",
      history: history(night, 900),
      now: night,
    });
    expect(verdict.factors.some((f) => f.name === "purpose_red_flag")).toBe(true);
    expect(verdict.factors.some((f) => f.name === "hour_anomaly")).toBe(true);
  });

  it("reaches HIGH (step-up) for a risky new-payee drain attempt", () => {
    const verdict = scoreTransfer({
      wallet,
      amount: 60,
      to: "compute:0xNEW0001",
      purpose: "emergency drain",
      history: history(night, 200),
      now: night,
    });
    expect(verdict.level).toBe("HIGH");
    expect(verdict.score).toBeGreaterThanOrEqual(STEP_UP_THRESHOLD);
    expect(verdict.score).toBeLessThan(CRITICAL_THRESHOLD);
  });

  it("reaches CRITICAL (hard reject) for a max-cap drain", () => {
    const verdict = scoreTransfer({
      wallet,
      amount: 100,
      to: "compute:0xNEW0001",
      purpose: "drain everything",
      history: history(night, 950),
      now: night,
    });
    expect(verdict.level).toBe("CRITICAL");
    expect(verdict.score).toBeGreaterThanOrEqual(CRITICAL_THRESHOLD);
  });

  it("maps scores to levels monotonically", () => {
    expect(riskLevel(0)).toBe("LOW");
    expect(riskLevel(24)).toBe("LOW");
    expect(riskLevel(25)).toBe("MEDIUM");
    expect(riskLevel(54)).toBe("MEDIUM");
    expect(riskLevel(55)).toBe("HIGH");
    expect(riskLevel(84)).toBe("HIGH");
    expect(riskLevel(85)).toBe("CRITICAL");
    expect(riskLevel(100)).toBe("CRITICAL");
  });

  it("adjustScore attaches a factor and re-scores without mutation", () => {
    const base = scoreTransfer({
      wallet,
      amount: 40,
      to: KNOWN_PAYEE,
      purpose: "gpu burst",
      history: history(noon, 0),
      now: noon,
    });
    const before = base.score;
    const adjusted = adjustScore(base, {
      name: "intent_anomaly",
      points: 15,
      reason: "LLM disagrees with claimed intent",
    });
    expect(adjusted.score).toBe(before + 15);
    expect(adjusted.factors.some((f) => f.name === "intent_anomaly")).toBe(true);
    expect(base.factors.some((f) => f.name === "intent_anomaly")).toBe(false);
  });
});
