import type { NextRequest } from "next/server";
import { authenticate, authorize, error, json } from "@/core/api";
import {
  createWebhook,
  deleteWebhook,
  listWebhookDeliveries,
  listWebhooks,
  updateWebhook,
} from "@/core/store";

export const runtime = "nodejs";

/**
 * Webhook console — self-serve endpoints subscribed to outbox event types.
 *   GET    /api/webhooks            list endpoints (+ latest deliveries each)
 *   POST   /api/webhooks            create endpoint  {url, secret?, eventTypes?}
 *   PATCH  /api/webhooks            update endpoint  {id, url?, secret?, eventTypes?, active?}
 *   DELETE /api/webhooks?id=        delete endpoint
 */
export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);
  const endpoints = await listWebhooks(claims!.walletId === "*" ? undefined : claims!.walletId);
  const deliveries = await Promise.all(
    endpoints.map((w) => listWebhookDeliveries(w.id, 20)),
  );
  return json({
    endpoints,
    deliveries: Object.fromEntries(endpoints.map((w, i) => [w.id, deliveries[i]])),
  });
}

export async function POST(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const body = await req.json().catch(() => null);
  if (!body?.url || typeof body.url !== "string") return error("url is required", 400);

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(body.url);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error();
  } catch {
    return error("url must be a valid http(s) endpoint", 400);
  }

  const eventTypes = Array.isArray(body.eventTypes)
    ? body.eventTypes.map(String)
    : body.eventTypes
      ? [String(body.eventTypes)]
      : [];

  const endpoint = await createWebhook({
    url: body.url,
    secret: typeof body.secret === "string" && body.secret ? body.secret : crypto.randomUUID(),
    eventTypes,
    orgId: claims!.walletId === "*" ? undefined : claims!.walletId,
  });
  return json({ endpoint }, 201);
}

export async function PATCH(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const body = await req.json().catch(() => null);
  if (!body?.id || typeof body.id !== "string") return error("id is required", 400);

  const endpoint = await updateWebhook(body.id, {
    url: typeof body.url === "string" ? body.url : undefined,
    secret: typeof body.secret === "string" ? body.secret : undefined,
    eventTypes: Array.isArray(body.eventTypes) ? body.eventTypes.map(String) : undefined,
    active: typeof body.active === "boolean" ? body.active : undefined,
  });
  if (!endpoint) return error("Webhook not found", 404);
  return json({ endpoint });
}

export async function DELETE(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return error("id query param is required", 400);

  const existing = await listWebhooks();
  if (!existing.some((w) => w.id === id)) return error("Webhook not found", 404);
  await deleteWebhook(id);
  return json({ ok: true });
}
