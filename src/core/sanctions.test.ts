import { describe, expect, it } from "vitest";
import { checkSanctions, runGuard } from "@/core/guard";
import { screenCounterparty, screenName } from "@/core/sanctions";
import type { Wallet } from "@/core/types";

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
    velocityLimitPerMin: 30,
    allowlist: ["Aurora Trade Group", "vendor:b"],
  },
  createdAt: 0,
};

const emptyCtx = { spentLast24h: 0, spentLast30d: 0, txCountLastMin: 0, now: Date.now() };

describe("OFAC-lite sanctions screen", () => {
  it("matches an exact entry name", () => {
    const m = screenName("Aurora Trade Group");
    expect(m?.entry.name).toBe("Aurora Trade Group");
    expect(m?.kind).toBe("exact");
  });

  it("matches via a stored alias", () => {
    const m = screenName("ATG Ltd");
    expect(m?.kind).toBe("alias");
    expect(m?.entry.name).toBe("Aurora Trade Group");
  });

  it("is case/punctuation-insensitive", () => {
    const m = screenName("  HALE & VOSS   Holdings ");
    expect(m?.entry.name).toBe("Hale & Voss Holdings");
  });

  it("matches a contained fragment (min length guarded)", () => {
    expect(screenName("KGF Bank (client #4412)")).not.toBeNull();
    expect(screenName("K")).toBeNull();
  });

  it("leaves a clean name alone", () => {
    expect(screenName("compute:0xCAFE0001")).toBeNull();
    expect(screenName("Acme Widgets")).toBeNull();
  });
});

describe("sanctions in the guard", () => {
  it("blocks a watchlist hit even when the payee is allowlisted", () => {
    const r = runGuard(baseWallet, 10, "Aurora Trade Group", emptyCtx, {
      sanctionsMatch: screenCounterparty({ name: "Aurora Trade Group" }),
    });
    expect(r).toMatchObject({ allowed: false, reason: "SANCTIONED" });
  });

  it("is skipped when no match is supplied", () => {
    const r = runGuard(baseWallet, 10, "vendor:b", emptyCtx);
    expect(r.allowed).toBe(true);
  });

  it("checkSanctions denies with the program detail in the message", () => {
    const r = checkSanctions(screenName("Orion Shipping Lines"), "Orion Shipping Lines");
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("SANCTIONED");
    expect(r.details).toContain("SDNTK");
  });
});
