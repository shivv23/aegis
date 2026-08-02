import type { NextRequest } from "next/server";
import { z } from "zod";
import { authenticate, authorize, error, json } from "@/core/api";
import { deleteSearch, listSavedSearches, saveSearch } from "@/core/store";

export const runtime = "nodejs";

const saveSchema = z.object({
  name: z.string().min(1).max(60),
  filters: z.record(z.string(), z.unknown()),
});

export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);
  return json({ searches: await listSavedSearches(claims!.walletId) });
}

export async function POST(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const parsed = saveSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error("Invalid search payload", 400);

  const search = await saveSearch(claims!.walletId, parsed.data.name, parsed.data.filters);
  return json({ search }, 201);
}

export async function DELETE(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return error("id query param required", 400);
  await deleteSearch(id, claims!.walletId);
  return json({ ok: true });
}
