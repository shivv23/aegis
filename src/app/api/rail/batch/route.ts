import type { NextRequest } from "next/server";
import { z } from "zod";
import { authenticate, authorize, error, json } from "@/core/api";
import { runTransfer } from "@/core/executor";
import { addAudit, recordOutbox } from "@/core/store";
import { randomUUID } from "node:crypto";

export const runtime = "nodejs";

const rowSchema = z.object({
  to: z.string().min(1),
  amount: z.number().positive().finite(),
  purpose: z.string().optional().default("agent-transfer"),
});

const bodySchema = z.object({
  walletId: z.string().optional(),
  transfers: z.array(rowSchema).min(1).max(100),
  idempotencyKey: z.string().min(1).optional(),
});

/**
 * POST /api/rail/batch
 *
 * Runs every row through the SAME guard as a single transfer and returns a
 * per-row result + a batch summary + one outbox event. A payroll CSV in,
 * a color-coded result table out.
 */
export async function POST(req: NextRequest) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error("Invalid batch payload", 400);

  const claims = await authenticate(req);
  // Batch is a treasury/ops tool: owner keys (console) or agent keys (SDK).
  const owner = authorize(claims, "owner");
  const agent = authorize(claims, "agent");
  if (!owner.ok && !agent.ok) return error(owner.reason!, 401);

  const isAgent = agent.ok;
  const walletId = isAgent ? claims!.walletId : parsed.data.walletId;
  if (!walletId) return error("walletId required for owner-scoped batch", 400);

  const now = Date.now();
  const batchKey = parsed.data.idempotencyKey ?? `batch:${randomUUID()}`;
  const results: Array<Record<string, unknown>> = [];

  for (const [index, row] of parsed.data.transfers.entries()) {
    const outcome = await runTransfer({
      walletId,
      to: row.to,
      amount: row.amount,
      purpose: row.purpose,
      now,
      idempotencyKey: `${batchKey}:${index}`,
    });
    const body = outcome.body as {
      status?: string;
      reason?: string;
      details?: string;
      transaction?: { id?: string };
    };
    results.push({
      index,
      to: row.to,
      amount: row.amount,
      purpose: row.purpose,
      status: body.status ?? "ERROR",
      reason: body.reason,
      details: body.details,
      txId: body.transaction?.id,
    });
  }

  const summary = {
    total: results.length,
    pending: results.filter((r) => r.status === "PENDING").length,
    settled: results.filter((r) => r.status === "SETTLED").length,
    stepUp: results.filter((r) => r.status === "STEP_UP_REQUIRED").length,
    blocked: results.filter((r) => r.status === "BLOCKED").length,
  };

  await addAudit({
    walletId,
    actor: isAgent ? "agent" : "owner",
    action: "BATCH_TRANSFER",
    details: `Batch of ${results.length} transfers: ${summary.pending} pending, ${summary.blocked} blocked, ${summary.stepUp} step-up`,
  });
  await recordOutbox(walletId, "BATCH_SUMMARY", {
    batchKey,
    total: summary.total,
    pending: summary.pending,
    settled: summary.settled,
    stepUp: summary.stepUp,
    blocked: summary.blocked,
  });

  return json({ batchKey, results, summary });
}
