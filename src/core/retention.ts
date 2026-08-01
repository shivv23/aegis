import type { Db } from "./db";

/**
 * Retention policy for operational data. Defaults mirror a sensible
 * compliance posture and are overridable per-deployment:
 *   AEGIS_AUDIT_RETENTION_YEARS  — how long audit rows are kept (default 7)
 *   AEGIS_OUTBOX_RETENTION_DAYS  — how long outbox deliveries are kept (default 30)
 */

export function retentionConfig() {
  return {
    auditYears: Number(process.env.AEGIS_AUDIT_RETENTION_YEARS ?? 7),
    outboxDays: Number(process.env.AEGIS_OUTBOX_RETENTION_DAYS ?? 30),
  };
}

/** Deletes audit rows older than the retention window. Returns rows removed. */
export async function pruneAudit(
  client: Db,
  now = Date.now(),
): Promise<number> {
  const { auditYears } = retentionConfig();
  const cutoff = now - auditYears * 365 * 24 * 60 * 60 * 1000;
  const { rows: before } = await client.execute(
    "SELECT COUNT(*) AS n FROM audit WHERE timestamp < ?",
    [cutoff],
  );
  await client.execute("DELETE FROM audit WHERE timestamp < ?", [cutoff]);
  return Number(before[0]?.n ?? 0);
}

/** Deletes delivered outbox rows older than the retention window. */
export async function pruneOutbox(
  client: Db,
  now = Date.now(),
): Promise<number> {
  const { outboxDays } = retentionConfig();
  const cutoff = now - outboxDays * 24 * 60 * 60 * 1000;
  const { rows: before } = await client.execute(
    "SELECT COUNT(*) AS n FROM outbox WHERE delivered_at IS NOT NULL AND delivered_at < ?",
    [cutoff],
  );
  await client.execute(
    "DELETE FROM outbox WHERE delivered_at IS NOT NULL AND delivered_at < ?",
    [cutoff],
  );
  return Number(before[0]?.n ?? 0);
}
