import type { NextRequest } from "next/server";
import { authenticate, authorize, error, json } from "@/core/api";
import { runRecurringDue } from "@/core/executor";

export const runtime = "nodejs";

/**
 * POST /api/rail/recurring/run
 * Triggers every due schedule immediately. The cron route also calls this
 * periodically so schedules advance even without a visitor.
 */
export async function POST(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  return json(await runRecurringDue());
}
