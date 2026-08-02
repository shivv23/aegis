import type { NextRequest } from "next/server";
import { authenticate, authorize, error, json } from "@/core/api";
import { deleteWebauthnCredential, listWebauthnCredentials } from "@/core/store";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const walletId = req.nextUrl.searchParams.get("walletId") ?? claims!.walletId;
  if (claims!.walletId !== "*" && claims!.walletId !== walletId) {
    return error("Key not authorized for this wallet", 403);
  }
  return json({ credentials: await listWebauthnCredentials(walletId) });
}

export async function DELETE(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return error("id query param required", 400);
  const ok = await deleteWebauthnCredential(id);
  if (!ok) return error("Credential not found", 404);
  return json({ ok: true });
}
