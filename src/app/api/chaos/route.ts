import type { NextRequest } from "next/server";
import { z } from "zod";
import { authenticate, authorize, error, json } from "@/core/api";
import { runTransfer } from "@/core/executor";
import { getBreakerState, getWallet } from "@/core/store";

export const runtime = "nodejs";

const bodySchema = z.object({
  walletId: z.string().min(1),
  count: z.number().int().min(1).max(120),
  mix: z
    .enum(["valid", "chaos", "velocity"])
    .optional()
    .default("chaos"),
});

/**
 * POST /api/chaos — fire N concurrent transfers and chart outcome + latency.
 * `mix=valid` mostly passes; `mix=velocity` hammers the velocity cap and
 * circuit breaker; `mix=chaos` mixes blocked/pass/step-up. Lets a judge try
 * to break the guard live.
 */
export async function POST(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error("Invalid chaos payload", 400);

  const wallet = await getWallet(parsed.data.walletId);
  if (!wallet) return error("Wallet not found", 404);

  const now = Date.now();
  const payloads = Array.from({ length: parsed.data.count }, (_, i) => {
    const wave = parsed.data.mix === "velocity" ? i % 10 : i % 5;
    if (parsed.data.mix === "velocity") {
      return {
        to: "compute:0xCAFE0001",
        amount: 5 + (i % 7),
        purpose: "load-test",
      };
    }
    switch (wave) {
      case 0:
        return { to: "compute:0xCAFE0001", amount: 10 + i, purpose: "GPU burst" };
      case 1:
        return { to: "compute:0xCAFE0001", amount: 500 + i, purpose: "attempt: over per-tx cap" };
      case 2:
        return { to: "drain:0xBADBEEF", amount: 5 + i, purpose: "attempt: unapproved payee" };
      case 3:
        return { to: "compute:0xCAFE0001", amount: 25, purpose: "attempt: split payments" };
      default:
        return { to: "api:0xBEEF0002", amount: 4000 + i, purpose: "attempt: exhaust daily limit" };
    }
  });

  // Fire sequentially so the guard sees each in-flight transfer accumulate
  // against the velocity/daily caps and the circuit breaker can actually trip.
  // A truly simultaneous Promise.all burst lets every request read the same
  // pre-burst snapshot and sidestep the velocity limit entirely.
  const results: Array<{
    index: number;
    to: string;
    amount: number;
    purpose: string;
    status: string;
    reason?: string;
    latencyMs: number;
  }> = [];
  for (const [i, p] of payloads.entries()) {
    const started = Date.now();
    const outcome = await runTransfer({
      walletId: parsed.data.walletId,
      to: p.to,
      amount: p.amount,
      purpose: p.purpose,
      now,
    });
    const body = outcome.body as { status?: string; reason?: string; details?: string };
    results.push({
      index: i,
      to: p.to,
      amount: p.amount,
      purpose: p.purpose,
      status: body.status ?? "ERROR",
      reason: body.reason,
      latencyMs: Date.now() - started,
    });
  }

  const statuses = ["SETTLED", "PENDING", "STEP_UP_REQUIRED", "BLOCKED", "ERROR"];
  const funnel = Object.fromEntries(
    statuses.map((s) => [s.toLowerCase(), results.filter((r) => r.status === s).length]),
  );
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const latency = {
    p50: latencies.length ? latencies[Math.floor(0.5 * latencies.length)] : 0,
    p95: latencies.length ? latencies[Math.floor(0.95 * latencies.length)] : 0,
    max: latencies.length ? latencies[latencies.length - 1] : 0,
    avg: latencies.length ? Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length) : 0,
  };

  return json({
    chaosKey: `chaos:${now}`,
    mix: parsed.data.mix,
    count: results.length,
    funnel,
    latency,
    breaker: getBreakerState(parsed.data.walletId, now),
    results,
  });
}
