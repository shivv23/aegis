/**
 * Channel-routing preferences for the alerts center.
 *
 * Global per-channel toggles plus per-event-type routing overrides. Stored
 * in-memory (keyed by owner email or "default") so the UI can persist within
 * the process without touching the ledger.
 */

export type NotifyChannel = "webhook" | "slack" | "email";

export interface NotificationPrefs {
  channels: Record<NotifyChannel, boolean>;
  perEvent: Record<string, string[]>;
}

export const ALL_CHANNELS: NotifyChannel[] = ["webhook", "slack", "email"];

export const KNOWN_EVENTS: string[] = [
  "tx.blocked",
  "tx.frozen",
  "tx.settled",
  "approval.pending",
  "approval.expired",
  "budget.warning",
  "breaker.tripped",
  "key.expiring",
  "in_flight.revoked",
  "ledger.broken",
];

export function defaultPrefs(): NotificationPrefs {
  return {
    channels: { webhook: true, slack: false, email: false },
    perEvent: {},
  };
}

export function channelsForEvent(prefs: NotificationPrefs, eventType: string): string[] {
  const override = prefs.perEvent[eventType];
  if (override) return [...override];
  return ALL_CHANNELS.filter((c) => prefs.channels[c]);
}

export function mergePrefs(
  base: NotificationPrefs,
  patch: Partial<NotificationPrefs>,
): NotificationPrefs {
  return {
    channels: patch.channels ? { ...base.channels, ...patch.channels } : { ...base.channels },
    perEvent: patch.perEvent ? { ...patch.perEvent } : { ...base.perEvent },
  };
}

const prefsStore = new Map<string, NotificationPrefs>();

export function getPrefs(key?: string): NotificationPrefs {
  const stored = prefsStore.get(key ?? "default") ?? defaultPrefs();
  return { ...stored, channels: { ...stored.channels }, perEvent: { ...stored.perEvent } };
}

export function setPrefs(prefs: Partial<NotificationPrefs>, key?: string): NotificationPrefs {
  const storeKey = key ?? "default";
  const merged = mergePrefs(getPrefs(storeKey), prefs);
  prefsStore.set(storeKey, merged);
  return merged;
}
