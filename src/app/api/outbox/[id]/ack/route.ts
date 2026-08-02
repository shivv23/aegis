import type { NextRequest } from "next/server";
import { z } from "zod";
import { authenticate, authorize, error, json } from "@/core/api";
import { acknowledgeOutbox } from "@/core/store";

export const runtime = "nodejs";

const ackSchema = z.object({
  note: z.string().max(200).optional().default("acknowledged"),
});

/**
 * POST /api/outbox/:id/ack — acknowledge a threshold/structuring alert
 * (who + why), audited. The alert stays in the feed but is marked acked.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const parsed = ackSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error("Invalid ack payload", 400);

  const entry = await acknowledgeOutbox(id, claims!.walletId, parsed.data.note);
  if (!entry) return error("Alert not found", 404);
  return json({ alert: entry, acknowledged: true });
}
