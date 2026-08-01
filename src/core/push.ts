/**
 * Push-alert delivery for the ops outbox. When AEGIS_WEBHOOK_URL is set, every
 * outbox event is POSTed to it (fire-and-forget). Without it, alerts stay in
 * the SSE outbox only — push is optional and never blocks the money path.
 */
import type { OutboxEntry } from "./types";

const WEBHOOK_URL = process.env.AEGIS_WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.AEGIS_WEBHOOK_SECRET;

export function pushAlertEnabled(): boolean {
  return Boolean(WEBHOOK_URL);
}

/**
 * Delivers an outbox entry to the configured webhook. Resolves false when no
 * webhook is configured or delivery fails — callers must never block on it.
 */
export async function deliverAlert(entry: OutboxEntry): Promise<boolean> {
  if (!WEBHOOK_URL) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(WEBHOOK_SECRET ? { "x-aegis-webhook": WEBHOOK_SECRET } : {}),
    };
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        event: entry.eventType,
        walletId: entry.walletId,
        payload: JSON.parse(entry.payload),
        createdAt: entry.createdAt,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}
