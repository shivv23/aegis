import type { NextRequest } from "next/server";
import { authenticate, authorize, error, json } from "@/core/api";
import { deleteRecurringSchedule } from "@/core/store";

export const runtime = "nodejs";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const ok = await deleteRecurringSchedule(id);
  if (!ok) return error("Schedule not found", 404);
  return json({ ok: true });
}
