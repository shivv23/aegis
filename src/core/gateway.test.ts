import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { checkRateLimit, rlConfig } from "@/core/ratelimit";
import { getStore, listRequestAudit, recordRequestAudit, resetRequestAudit } from "@/core/store";
import { SEED_WALLET_ID } from "@/core/seed";

afterEach(() => {
  delete process.env.AEGIS_RL_DISABLED;
  delete process.env.AEGIS_RL_KEY_CAP;
  delete process.env.AEGIS_RL_KEY_RPS;
});

describe("rate limiting (B3)", () => {
  it("allows requests within capacity and counts down", () => {
    process.env.AEGIS_RL_KEY_CAP = "3";
    process.env.AEGIS_RL_KEY_RPS = "1000";
    const keyHash = "k".repeat(64);
    const r1 = checkRateLimit({ keyHash, ip: "1.2.3.4" });
    const r2 = checkRateLimit({ keyHash, ip: "1.2.3.4" });
    const r3 = checkRateLimit({ keyHash, ip: "1.2.3.4" });
    expect(r1.key.ok).toBe(true);
    expect(r2.key.ok).toBe(true);
    expect(r3.key.ok).toBe(true);
    expect(r3.key.remaining).toBe(0);
  });

  it("rejects with retry-after once the bucket is exhausted", () => {
    process.env.AEGIS_RL_KEY_CAP = "1";
    process.env.AEGIS_RL_KEY_RPS = "1";
    const keyHash = "q".repeat(64);
    expect(checkRateLimit({ keyHash, ip: "9.9.9.9" }).key.ok).toBe(true);
    const blocked = checkRateLimit({ keyHash, ip: "9.9.9.9" }).key;
    expect(blocked.ok).toBe(false);
    expect(blocked.resetInMs).toBeGreaterThan(0);
  });

  it("limits per IP independently of the key", () => {
    process.env.AEGIS_RL_IP_CAP = "2";
    process.env.AEGIS_RL_IP_RPS = "1000";
    process.env.AEGIS_RL_KEY_CAP = "100";
    expect(checkRateLimit({ keyHash: "a".repeat(64), ip: "7.7.7.7" }).ip.ok).toBe(true);
    expect(checkRateLimit({ keyHash: "b".repeat(64), ip: "7.7.7.7" }).ip.ok).toBe(true);
    expect(checkRateLimit({ keyHash: "c".repeat(64), ip: "7.7.7.7" }).ip.ok).toBe(false);
    expect(checkRateLimit({ keyHash: "c".repeat(64), ip: "8.8.8.8" }).ip.ok).toBe(true);
  });

  it("can be disabled via env", () => {
    process.env.AEGIS_RL_DISABLED = "1";
    process.env.AEGIS_RL_KEY_CAP = "1";
    process.env.AEGIS_RL_KEY_RPS = "0.001";
    const keyHash = "z".repeat(64);
    expect(checkRateLimit({ keyHash, ip: "1.1.1.1" }).key.ok).toBe(true);
    expect(checkRateLimit({ keyHash, ip: "1.1.1.1" }).key.ok).toBe(true);
  });
});

describe("request audit (B4)", () => {
  beforeAll(async () => {
    await getStore().ready;
    await resetRequestAudit();
  });

  it("records an entry with actor metadata and lists newest-first", async () => {
    await recordRequestAudit({
      method: "POST",
      path: "/api/rail/transfer",
      keyHash: "h1",
      scope: "agent",
      walletId: SEED_WALLET_ID,
      ip: "203.0.113.7",
      userAgent: "agent-framework/1.0",
      result: "OK",
    });
    await new Promise((r) => setTimeout(r, 5));
    await recordRequestAudit({
      method: "GET",
      path: "/api/ledger/verify",
      keyHash: "h2",
      scope: "owner",
      walletId: "*",
      ip: "203.0.113.8",
      result: "OK",
    });

    const entries = await listRequestAudit();
    expect(entries).toHaveLength(2);
    expect(entries[0].path).toBe("/api/ledger/verify");
    expect(entries[1].ip).toBe("203.0.113.7");
    expect(entries[1].userAgent).toBe("agent-framework/1.0");
  });
});
