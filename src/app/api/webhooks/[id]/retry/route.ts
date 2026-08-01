import type { NextRequest } from "next/server";
import { authenticate, authorize, error, json } from "@/core/api";
import { createHmac } from "node:crypto";
import {
  getWebhook,
  getWebhookDelivery,
  recordWebhookDelivery,
} from "@/core/store";

export const runtime = "nodejs";

/**
 * POST /api/webhooks/[id]/retry
 * Re-delivers a previously recorded delivery to its endpoint. The exact stored
 * payload is replayed with a fresh HMAC signature and a new delivery row.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const deliveryId = typeof body.deliveryId === "string" ? body.deliveryId : undefined;

  if (!deliveryId) return error("deliveryId is required", 400);

  const endpoint = await getWebhook(id);
  if (!endpoint) return error("Webhook not found", 404);
  const delivery = await getWebhookDelivery(deliveryId);
  if (!delivery || delivery.webhookId !== id) return error("Delivery not found", 404);

  try {
    const signature = createHmac("sha256", endpoint.secret)
      .update(delivery.payload)
      .digest("hex");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-aegis-webhook": signature,
        "x-aegis-replay": "true",
      },
      body: delivery.payload,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const recorded = await recordWebhookDelivery(
      id,
      delivery.eventType,
      delivery.payload,
      res.ok ? "DELIVERED" : "FAILED",
      res.status,
    );
    return json({ replayed: true, delivery: recorded });
  } catch {
    const recorded = await recordWebhookDelivery(
      id,
      delivery.eventType,
      delivery.payload,
      "FAILED",
    );
    return json({ replayed: false, delivery: recorded }, 502);
  }
}
