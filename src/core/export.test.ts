import { describe, expect, it } from "vitest";
import { auditLogCsv, auditPackCsv, sarLiteReport } from "@/core/export";
import type { AuditLogEntry, Transaction } from "@/core/types";

const tx = (over: Partial<Transaction> = {}): Transaction => ({
  id: "t1",
  walletId: "w1",
  from: "w1",
  to: "vendor:a",
  amount: 250,
  purpose: "gpu burst",
  status: "SETTLED",
  requestedAt: Date.UTC(2026, 5, 1, 10),
  settledAt: Date.UTC(2026, 5, 1, 10, 5),
  nonce: "n1",
  ...over,
});

describe("auditPackCsv", () => {
  it("emits a header row and one row per transaction", () => {
    const csv = auditPackCsv([tx(), tx({ id: "t2", to: "vendor:b", amount: 75 })]);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toContain("id,wallet");
    expect(lines).toHaveLength(3);
  });

  it("escapes commas inside purpose text", () => {
    const csv = auditPackCsv([tx({ purpose: "compute, burst" })]);
    expect(csv).toContain('"compute, burst"');
  });
});

describe("auditLogCsv", () => {
  it("serializes audit entries", () => {
    const log: AuditLogEntry[] = [
      { id: "a1", walletId: "w1", actor: "agent", action: "TX_REQUESTED", details: "ok", timestamp: 1 },
    ];
    const csv = auditLogCsv(log);
    expect(csv.split("\n")).toHaveLength(2);
    expect(csv).toContain("TX_REQUESTED");
  });
});

describe("sarLiteReport", () => {
  it("flags counterparties over threshold", () => {
    const now = Date.UTC(2026, 6, 1);
    const big = Array.from({ length: 12 }, (_, i) => tx({ id: `big${i}`, to: "vendor:a", amount: 1000 }));
    const report = sarLiteReport([...big, tx({ to: "vendor:b", amount: 5 })], now, { usd: 10000, txCount: 100 });
    expect(report.totals.settledUsd).toBe(12005);
    const flagged = report.flagged.find((f) => f.to === "vendor:a");
    expect(flagged?.settledUsd).toBe(12000);
    expect(flagged?.flags.length).toBeGreaterThan(0);
  });

  it("does not flag counterparties under threshold", () => {
    const now = Date.UTC(2026, 6, 1);
    const report = sarLiteReport([tx({ amount: 50 })], now, { usd: 10000, txCount: 100 });
    expect(report.flagged).toHaveLength(0);
  });

  it("excludes transactions outside the reporting month", () => {
    const now = Date.UTC(2026, 6, 1);
    const old = tx({ requestedAt: Date.UTC(2026, 0, 1), settledAt: Date.UTC(2026, 0, 1) });
    const report = sarLiteReport([old, tx({ amount: 100 })], now);
    expect(report.totals.settledUsd).toBe(100);
  });
});
