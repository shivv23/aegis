"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Field } from "@/components/ui";
import { ownerApi } from "@/lib/api-client";
import { clock, shortId } from "@/lib/utils";
import { Check, Copy, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { WebhookDelivery, WebhookEndpoint } from "@/core/types";

const EVENT_TYPES = [
  "BLOCKED",
  "FROZEN",
  "STEP_UP_REQUIRED",
  "APPROVED",
  "DECLINED",
  "SETTLED",
  "ESCROW_HELD",
  "ESCROW_RELEASED",
  "KEY_MINTED",
];

export default function WebhooksPage() {
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [deliveries, setDeliveries] = useState<Record<string, WebhookDelivery[]>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [eventTypes, setEventTypes] = useState<string[]>(["BLOCKED", "STEP_UP_REQUIRED"]);
  const [open, setOpen] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const data = await ownerApi<{ endpoints: WebhookEndpoint[]; deliveries: Record<string, WebhookDelivery[]> }>("/api/webhooks");
    setEndpoints(data.endpoints ?? []);
    setDeliveries(data.deliveries ?? {});
  }, []);

  useEffect(() => {
    refresh().catch(() => setMessage("could not load webhooks"));
  }, [refresh]);

  const allEvents = useMemo(
    () => Array.from(new Set(endpoints.flatMap((w) => w.eventTypes))),
    [endpoints],
  );

  async function create() {
    setBusy(true);
    setMessage(null);
    try {
      const data = await ownerApi<{ endpoint: WebhookEndpoint }>("/api/webhooks", {
        method: "POST",
        body: JSON.stringify({ url, eventTypes }),
      });
      setEndpoints((prev) => [data.endpoint, ...prev]);
      setUrl("");
      setEventTypes(["BLOCKED", "STEP_UP_REQUIRED"]);
      setMessage("webhook endpoint created — secret shown once below");
      await refresh();
    } catch {
      setMessage("failed to create endpoint");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(endpoint: WebhookEndpoint) {
    await ownerApi("/api/webhooks", {
      method: "PATCH",
      body: JSON.stringify({ id: endpoint.id, active: !endpoint.active }),
    });
    refresh();
  }

  async function remove(endpoint: WebhookEndpoint) {
    await ownerApi(`/api/webhooks?id=${endpoint.id}`, { method: "DELETE" });
    setEndpoints((prev) => prev.filter((w) => w.id !== endpoint.id));
    refresh();
  }

  async function retry(endpoint: WebhookEndpoint, delivery: WebhookDelivery) {
    await ownerApi(`/api/webhooks/${endpoint.id}/retry`, {
      method: "POST",
      body: JSON.stringify({ deliveryId: delivery.id }),
    });
    refresh();
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-mono text-xl font-bold tracking-tight">Webhook Console</h1>
        <p className="text-sm text-muted">
          Endpoints that receive every guard decision, HMAC-signed per event.
          Nothing leaves the system silently.
        </p>
      </header>

      <div className="rounded-xl border border-border bg-panel/70 p-4 space-y-3">
        <h2 className="font-mono text-sm font-semibold uppercase tracking-widest text-muted">
          Register endpoint
        </h2>
        <div className="grid md:grid-cols-2 gap-3">
          <Field
            label="URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://ops.acme.dev/hooks/aegis"
            className="w-full font-mono text-xs"
          />
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-mono uppercase tracking-widest text-muted">
              Event types
            </span>
            <div className="flex flex-wrap gap-1.5">
              {EVENT_TYPES.map((t) => (
                <button
                  key={t}
                  onClick={() =>
                    setEventTypes((prev) =>
                      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t],
                    )
                  }
                  className={`px-2 py-1 rounded-md font-mono text-[10px] border ${
                    eventTypes.includes(t)
                      ? "border-info/60 bg-info/10 text-info"
                      : "border-border text-muted hover:border-info/30"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="primary" size="sm" disabled={busy || !url.trim()} onClick={create}>
            <Plus className="h-3.5 w-3.5" /> Create
          </Button>
          {message ? <span className="font-mono text-xs text-info">{message}</span> : null}
        </div>
      </div>

      {endpoints.length === 0 ? (
        <div className="rounded-xl border border-border bg-panel/70 px-4 py-12 text-center font-mono text-sm text-muted">
          no webhook endpoints registered
        </div>
      ) : (
        endpoints.map((endpoint) => (
          <div key={endpoint.id} className="rounded-xl border border-border bg-panel/70 overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-border">
              <div className="flex items-center gap-3 min-w-0">
                <span
                  className={`h-2 w-2 rounded-full ${endpoint.active ? "bg-emerald-400" : "bg-zinc-600"}`}
                />
                <span className="font-mono text-xs truncate">{endpoint.url}</span>
                <button
                  onClick={() => navigator.clipboard.writeText(endpoint.id)}
                  className="text-muted hover:text-foreground"
                  title="copy id"
                >
                  <Copy className="h-3 w-3" />
                </button>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] text-muted">
                  {endpoint.eventTypes.length === 0
                    ? "all events"
                    : endpoint.eventTypes.slice(0, 4).join(" · ") +
                      (endpoint.eventTypes.length > 4 ? " …" : "")}
                </span>
                <Button variant="outline" size="sm" onClick={() => toggle(endpoint)}>
                  {endpoint.active ? "Pause" : "Resume"}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setOpen(open === endpoint.id ? null : endpoint.id)}>
                  Log ({deliveries[endpoint.id]?.length ?? 0})
                </Button>
                <Button variant="danger" size="sm" onClick={() => remove(endpoint)}>
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            </div>

            {open === endpoint.id ? (
              <div>
                <div className="grid grid-cols-12 gap-2 px-4 py-2 border-b border-border font-mono text-[10px] uppercase tracking-widest text-muted">
                  <span className="col-span-3">Time</span>
                  <span className="col-span-3">Event</span>
                  <span className="col-span-2">Status</span>
                  <span className="col-span-2">HTTP</span>
                  <span className="col-span-2 text-right">Action</span>
                </div>
                {(deliveries[endpoint.id] ?? []).length === 0 ? (
                  <div className="px-4 py-6 text-center font-mono text-xs text-muted">
                    no deliveries yet — they appear the next time an event fires
                  </div>
                ) : (
                  (deliveries[endpoint.id] ?? []).map((d) => (
                    <div
                      key={d.id}
                      className="grid grid-cols-12 gap-2 items-center px-4 py-2 border-b border-border/60 last:border-0 font-mono text-xs"
                    >
                      <span className="col-span-3 text-muted">{clock(d.attemptedAt)}</span>
                      <span className="col-span-3 truncate">{d.eventType}</span>
                      <span className="col-span-2">
                        <span
                          className={
                            d.status === "DELIVERED"
                              ? "text-emerald-400"
                              : d.status === "FAILED"
                                ? "text-red-400"
                                : "text-amber-400"
                          }
                        >
                          {d.status}
                        </span>
                      </span>
                      <span className="col-span-2 text-muted">{d.httpStatus ?? "—"}</span>
                      <span className="col-span-2 text-right">
                        {d.status === "FAILED" ? (
                          <Button variant="warn" size="sm" onClick={() => retry(endpoint, d)}>
                            <RefreshCw className="h-3 w-3" /> Retry
                          </Button>
                        ) : (
                          <span className="text-muted">{shortId(d.id, 10)}</span>
                        )}
                      </span>
                    </div>
                  ))
                )}
              </div>
            ) : null}
          </div>
        ))
      )}

      {allEvents.length > 0 ? (
        <p className="font-mono text-[10px] text-muted">
          observed event types: {allEvents.join(" · ")}
        </p>
      ) : null}
    </div>
  );
}
