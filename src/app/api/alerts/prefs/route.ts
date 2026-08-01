import type { NextRequest } from "next/server";
import { authenticate, authorize, error, json } from "@/core/api";
import { ALL_CHANNELS, KNOWN_EVENTS, getPrefs, setPrefs } from "@/core/notify";
import type { NotificationPrefs, NotifyChannel } from "@/core/notify";

export const runtime = "nodejs";

/**
 * GET /api/alerts/prefs — current notification preferences plus the channel
 * and event-type catalogs the alerts UI renders.
 * PUT /api/alerts/prefs — replace preferences from {channels?, perEvent?}.
 */
export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);
  return json({ prefs: getPrefs(), channels: ALL_CHANNELS, eventTypes: KNOWN_EVENTS });
}

function sanitizeChannels(
  value: unknown,
  current: NotificationPrefs,
): Record<NotifyChannel, boolean> {
  const out = { ...current.channels };
  if (!value || typeof value !== "object") return out;
  const record = value as Record<string, unknown>;
  for (const channel of ALL_CHANNELS) {
    if (channel in record) out[channel] = record[channel] === true;
  }
  return out;
}

function sanitizePerEvent(value: unknown): Record<string, string[]> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const out: Record<string, string[]> = {};
  for (const [eventType, raw] of Object.entries(record)) {
    if (!KNOWN_EVENTS.includes(eventType)) continue;
    out[eventType] = Array.isArray(raw)
      ? raw.filter((c): c is NotifyChannel => typeof c === "string" && ALL_CHANNELS.includes(c as NotifyChannel))
      : [];
  }
  return out;
}

export async function PUT(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const body = (await req.json().catch(() => null)) as Partial<NotificationPrefs> | null;
  if (!body || typeof body !== "object") return error("Invalid prefs payload", 400);

  const patch: Partial<NotificationPrefs> = {};
  const current = getPrefs();
  patch.channels = sanitizeChannels(body.channels, current);
  const perEvent = sanitizePerEvent(body.perEvent);
  if (perEvent) patch.perEvent = perEvent;

  const updated = setPrefs(patch);
  return json({ prefs: updated });
}
