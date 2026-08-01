import { beforeAll, describe, expect, it } from "vitest";
import { addAudit, getStore, recordOutbox } from "@/core/store";
import { pruneAudit, pruneOutbox, retentionConfig } from "@/core/retention";
import { SEED_WALLET_ID } from "@/core/seed";

beforeAll(async () => {
  await getStore().ready;
});

describe("retention policy (C3)", () => {
  it("reads retention from env with sane defaults", () => {
    expect(retentionConfig().auditYears).toBeGreaterThanOrEqual(1);
    expect(retentionConfig().outboxDays).toBeGreaterThanOrEqual(1);
  });

  it("prunes audit rows older than the window", async () => {
    const old = Date.now() - 1000 * 24 * 60 * 60 * 365 * 7 - 1000;
    await getStore().client.execute(
      "INSERT INTO audit (id, wallet_id, actor, action, details, timestamp) VALUES (?, ?, 'system', 'OLD', 'expired', ?)",
      ["audit-prune-test", SEED_WALLET_ID, old],
    );
    const removed = await pruneAudit(getStore().client, Date.now());
    expect(removed).toBeGreaterThanOrEqual(1);
    const { rows } = await getStore().client.execute(
      "SELECT COUNT(*) AS n FROM audit WHERE id = 'audit-prune-test'",
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it("prunes delivered outbox rows older than the window", async () => {
    const old = Date.now() - 1000 * 24 * 60 * 60 * 60;
    await recordOutbox(SEED_WALLET_ID, "OLD_EVENT", "{}");
    await getStore().client.execute(
      "UPDATE outbox SET delivered_at = ? WHERE event_type = 'OLD_EVENT'",
      [old],
    );
    const removed = await pruneOutbox(getStore().client, Date.now());
    expect(removed).toBeGreaterThanOrEqual(1);
    const { rows } = await getStore().client.execute(
      "SELECT COUNT(*) AS n FROM outbox WHERE event_type = 'OLD_EVENT'",
    );
    expect(Number(rows[0].n)).toBe(0);
  });
});
