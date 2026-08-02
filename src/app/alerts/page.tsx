"use client";

import { useEffect, useMemo, useState } from "react";
import { Button, Card, StatCard } from "@/components/ui";
import { ownerApi } from "@/lib/api-client";
import { timeAgo } from "@/lib/utils";
import { AlertTriangle, Bell, Check, Inbox, Info, Settings2, ShieldAlert } from "lucide-react";
import type { NotificationPrefs, NotifyChannel } from "@/core/notify";

type Severity = "info" | "warning" | "critical";

interface AlertItem {
  id: string;
  type: string;
  severity: Severity;
  title: string;
  detail: string;
  at: number;
  link: string;
}

interface OutboxEntry {
  id: string;
  walletId: string;
  eventType: string;
  payload: string;
  createdAt: number;
  deliveredAt?: number;
  attemptCount: number;
}

function payloadOf(entry: OutboxEntry): Record<string, string> {
  try {
    return JSON.parse(entry.payload) as Record<string, string>;
  } catch {
    return { raw: entry.payload };
  }
}

function shortAddr(a: string): string {
  return a.length > 22 ? `${a.slice(0, 10)}…${a.slice(-8)}` : a;
}

const OUTBOX_LABELS: Record<string, string> = {
  STEP_UP_REQUIRED: "Owner approval required (deep-link sent)",
  STEP_UP_APPROVED: "Transfer approved from link",
  STEP_UP_DECLINED: "Transfer declined from link",
  TX_BLOCKED: "Transfer blocked by guard",
  TX_SETTLED: "Transfer settled",
  WALLET_FROZEN: "Kill switch engaged",
  WALLET_UNFROZEN: "Kill switch released",
  ANOMALY: "Guard anomaly",
  BREAKER_TRIPPED: "Circuit breaker tripped",
};

const SEVERITY_ORDER: Severity[] = ["critical", "warning", "info"];

const severityMeta: Record<
  Severity,
  { label: string; icon: typeof ShieldAlert; dot: string; row: string }
> = {
  critical: { label: "Critical", icon: ShieldAlert, dot: "text-danger", row: "text-danger" },
  warning: { label: "Warning", icon: AlertTriangle, dot: "text-warn", row: "text-warn" },
  info: { label: "Info", icon: Info, dot: "text-info", row: "text-info" },
};

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [outbox, setOutbox] = useState<OutboxEntry[]>([]);
  const [channels, setChannels] = useState<NotifyChannel[]>([]);
  const [eventTypes, setEventTypes] = useState<string[]>([]);
  const [draft, setDraft] = useState<NotificationPrefs | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [alertsData, prefsData, outboxData] = await Promise.all([
          ownerApi<{ alerts: AlertItem[] }>("/api/alerts"),
          ownerApi<{ prefs: NotificationPrefs; channels: NotifyChannel[]; eventTypes: string[] }>(
            "/api/alerts/prefs",
          ),
          ownerApi<{ alerts: OutboxEntry[] }>("/api/outbox?limit=50"),
        ]);
        if (!active) return;
        setAlerts(alertsData.alerts);
        setChannels(prefsData.channels);
        setEventTypes(prefsData.eventTypes);
        setDraft(prefsData.prefs);
        setOutbox(outboxData.alerts ?? []);
        setError(null);
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const grouped = useMemo(() => {
    const groups: Record<Severity, AlertItem[]> = { critical: [], warning: [], info: [] };
    for (const a of alerts) groups[a.severity].push(a);
    return groups;
  }, [alerts]);

  const counts = useMemo(() => {
    const c: Record<Severity, number> = { critical: 0, warning: 0, info: 0 };
    for (const a of alerts) c[a.severity] += 1;
    return c;
  }, [alerts]);

  const effectiveFor = (eventType: string): string[] => {
    if (!draft) return [];
    const override = draft.perEvent[eventType];
    if (override) return override;
    return channels.filter((c) => draft.channels[c]);
  };

  const hasOverride = (eventType: string): boolean => Boolean(draft?.perEvent[eventType]);

  function toggleChannel(channel: NotifyChannel) {
    if (!draft) return;
    setDraft({ ...draft, channels: { ...draft.channels, [channel]: !draft.channels[channel] } });
    setSaved(false);
  }

  function toggleEventChannel(eventType: string, channel: NotifyChannel) {
    if (!draft) return;
    const current = draft.perEvent[eventType] ?? channels.filter((c) => draft.channels[c]);
    const next = current.includes(channel)
      ? current.filter((c) => c !== channel)
      : [...current, channel];
    setDraft({ ...draft, perEvent: { ...draft.perEvent, [eventType]: next } });
    setSaved(false);
  }

  function resetEvent(eventType: string) {
    if (!draft) return;
    const perEvent = { ...draft.perEvent };
    delete perEvent[eventType];
    setDraft({ ...draft, perEvent });
    setSaved(false);
  }

  async function savePrefs() {
    if (!draft) return;
    setSaving(true);
    setSaved(false);
    try {
      const res = await ownerApi<{ prefs: NotificationPrefs }>("/api/alerts/prefs", {
        method: "PUT",
        body: JSON.stringify(draft),
      });
      setDraft(res.prefs);
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-mono text-xl font-bold tracking-tight">Alerts</h1>
        <p className="text-sm text-muted">
          Everything the guard is holding, blocking, or about to break — one screen.
        </p>
      </header>

      {error && alerts.length === 0 ? (
        <div className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-8 text-center font-mono text-sm text-danger">
          {error}
        </div>
      ) : null}

      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Critical" value={String(counts.critical)} tone="danger" />
        <StatCard label="Warnings" value={String(counts.warning)} tone="warn" />
        <StatCard label="Info" value={String(counts.info)} tone="info" />
      </div>

      {loading ? (
        <Card className="px-4 py-12 text-center font-mono text-sm text-muted">
          loading alerts…
        </Card>
      ) : alerts.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 px-4 py-12 text-center">
          <Bell className="h-6 w-6 text-muted" />
          <p className="font-mono text-sm text-muted">all quiet — no alerts need attention</p>
        </Card>
      ) : (
        SEVERITY_ORDER.map((sev) => {
          const items = grouped[sev];
          if (items.length === 0) return null;
          const meta = severityMeta[sev];
          const Icon = meta.icon;
          return (
            <section key={sev} className="space-y-2">
              <h2 className="flex items-center gap-2 font-mono text-sm font-semibold text-zinc-200">
                <Icon className={`h-4 w-4 ${meta.dot}`} /> {meta.label} · {items.length}
              </h2>
              <Card className="overflow-hidden p-0 divide-y divide-border/60">
                {items.map((a) => (
                  <a
                    key={a.id}
                    href={a.link}
                    className="flex items-start gap-3 px-4 py-3 hover:bg-white/[0.03]"
                  >
                    <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${meta.row}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="truncate font-mono text-xs font-semibold text-foreground">
                          {a.title}
                        </span>
                        <span className="shrink-0 font-mono text-[10px] text-muted">
                          {timeAgo(a.at)}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-muted">{a.detail}</p>
                    </div>
                  </a>
                ))}
              </Card>
            </section>
          );
        })
      )}

      <section className="space-y-2">
        <h2 className="flex items-center gap-2 font-mono text-sm font-semibold text-zinc-200">
          <Inbox className="h-4 w-4 text-info" /> Ops outbox · delivery log
          <span className="text-[10px] font-normal text-muted">
            what the guard pushed, and the deep-links it carries
          </span>
        </h2>
        <Card className="overflow-hidden p-0">
          {outbox.length === 0 ? (
            <div className="px-4 py-8 text-center font-mono text-xs text-muted">
              no outbound events yet — fire a transfer that needs approval and its
              link lands here
            </div>
          ) : (
            <div className="divide-y divide-border/60">
              {outbox.map((e) => {
                const p = payloadOf(e);
                const approve = p.approveLink;
                const decline = p.declineLink;
                return (
                  <div key={e.id} className="flex items-start gap-3 px-4 py-3">
                    <Bell className="mt-0.5 h-4 w-4 shrink-0 text-info" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="truncate font-mono text-xs font-semibold text-foreground">
                          {OUTBOX_LABELS[e.eventType] ?? e.eventType}
                        </span>
                        <span className="shrink-0 font-mono text-[10px] text-muted">
                          {timeAgo(e.createdAt)} · wallet {shortAddr(e.walletId)} · {e.attemptCount} delivery{e.attemptCount === 1 ? "" : "s"}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate font-mono text-[11px] text-muted">
                        {p.amount ? `${p.amount} → ${shortAddr(p.to ?? "")}` : ""}
                        {p.score ? ` · risk ${p.score}` : ""}
                        {e.deliveredAt ? " · delivered" : " · pending delivery"}
                      </p>
                      {approve || decline ? (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {approve ? (
                            <a href={approve} target="_blank" rel="noreferrer">
                              <Button variant="primary" size="sm">
                                <Check className="h-3 w-3" /> Approve
                              </Button>
                            </a>
                          ) : null}
                          {decline ? (
                            <a href={decline} target="_blank" rel="noreferrer">
                              <Button variant="danger" size="sm">Decline</Button>
                            </a>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
        <p className="text-[11px] text-muted">
          Deep-links are minted as short-lived <code>aegis-decision</code> tokens and
          included in every outbound alert. Wire <code>AEGIS_SLACK_URL</code> or
          <code>AEGIS_RESEND_API_KEY</code> to deliver them to a real channel; without
          a gateway they stay here in the in-app outbox.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="flex items-center gap-2 font-mono text-sm font-semibold text-zinc-200">
          <Settings2 className="h-4 w-4 text-accent" /> Notification preferences
        </h2>
        <Card className="space-y-4">
          <div>
            <div className="mb-2 text-[11px] font-mono uppercase tracking-widest text-muted">
              Global channels
            </div>
            <div className="flex flex-wrap gap-4">
              {channels.map((c) => (
                <label
                  key={c}
                  className="flex cursor-pointer items-center gap-2 font-mono text-xs text-foreground"
                >
                  <input
                    type="checkbox"
                    checked={draft?.channels[c] ?? false}
                    onChange={() => toggleChannel(c)}
                    className="h-3.5 w-3.5 cursor-pointer accent-accent"
                  />
                  {c}
                </label>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-mono uppercase tracking-widest text-muted">
                Per-event routing
              </span>
              <span className="text-[10px] font-mono text-muted">
                override global channels per event type
              </span>
            </div>
            <div className="overflow-hidden rounded-md border border-border">
              {eventTypes.map((evt, i) => (
                <div
                  key={evt}
                  className={`flex flex-wrap items-center justify-between gap-2 px-3 py-2 ${
                    i > 0 ? "border-t border-border/60" : ""
                  } ${hasOverride(evt) ? "bg-accent/[0.04]" : ""}`}
                >
                  <span className="font-mono text-xs text-muted">{evt}</span>
                  <div className="flex items-center gap-4">
                    {channels.map((c) => (
                      <label
                        key={c}
                        className="flex cursor-pointer items-center gap-1.5 font-mono text-[10px] text-muted"
                      >
                        <input
                          type="checkbox"
                          checked={effectiveFor(evt).includes(c)}
                          onChange={() => toggleEventChannel(evt, c)}
                          className="h-3 w-3 cursor-pointer accent-accent"
                        />
                        {c}
                      </label>
                    ))}
                    <button
                      onClick={() => resetEvent(evt)}
                      disabled={!hasOverride(evt)}
                      className="font-mono text-[10px] text-info hover:text-accent disabled:opacity-30 disabled:pointer-events-none"
                    >
                      global
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-3 border-t border-border/60 pt-3">
            <Button variant="primary" size="sm" disabled={saving || !draft} onClick={savePrefs}>
              <Check className="h-3.5 w-3.5" /> Save
            </Button>
            {saved ? (
              <span className="flex items-center gap-1 font-mono text-xs text-emerald-400">
                <Check className="h-3 w-3" /> preferences saved
              </span>
            ) : null}
            {!saved && error ? (
              <span className="font-mono text-xs text-rose-400">{error}</span>
            ) : null}
          </div>
        </Card>
      </section>
    </div>
  );
}
