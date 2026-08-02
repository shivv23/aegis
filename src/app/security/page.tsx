"use client";

import { useCallback, useEffect, useState } from "react";
import { ownerApi } from "@/lib/api-client";
import { Button } from "@/components/ui";
import { clock, shortId } from "@/lib/utils";
import { RefreshCw, ShieldAlert } from "lucide-react";

interface SecurityEvent {
  id: string;
  ts: number;
  method: string;
  path: string;
  keyHash?: string;
  scope?: string;
  walletId?: string;
  ip?: string;
  userAgent?: string;
  result: string;
}

const resultTone: Record<string, string> = {
  OK: "text-emerald-400",
  INVALID: "text-danger",
  REVOKED: "text-warn",
  UNAUTHORIZED: "text-warn",
};

export default function SecurityPage() {
  const [events, setEvents] = useState<SecurityEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await ownerApi<{ events: SecurityEvent[] }>("/api/security?limit=200");
      setEvents(data.events ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "security feed unavailable");
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 font-mono text-xl font-bold tracking-tight">
            <ShieldAlert className="h-5 w-5 text-warn" />
            Security events
          </h1>
          <p className="text-sm text-muted">
            SIEM-lite feed: failed authentication (invalid / revoked /
            unauthorized tokens) plus every sensitive action — admin, freeze,
            policy, key and signer changes. The system watching itself.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh}>
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </Button>
      </header>

      {error ? (
        <div className="rounded-xl border border-border bg-panel/70 px-4 py-8 text-center font-mono text-sm text-warn">
          {error}
        </div>
      ) : events === null ? (
        <div className="rounded-xl border border-border bg-panel/70 px-4 py-10 text-center font-mono text-sm text-muted">
          reading…
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-panel/70 overflow-hidden">
          <div className="grid grid-cols-12 gap-2 px-4 py-2.5 border-b border-border font-mono text-[10px] uppercase tracking-widest text-muted">
            <span className="col-span-2">Time</span>
            <span className="col-span-1">Result</span>
            <span className="col-span-1">Method</span>
            <span className="col-span-4">Path</span>
            <span className="col-span-2">Key</span>
            <span className="col-span-2">Source</span>
          </div>
          {events.length === 0 ? (
            <div className="px-4 py-10 text-center font-mono text-sm text-muted">
              no security events yet — mint a key or try a bad token
            </div>
          ) : (
            events.map((e) => (
              <div
                key={e.id}
                className="grid grid-cols-12 gap-2 items-center px-4 py-2.5 border-b border-border/60 last:border-0 font-mono text-xs"
              >
                <span className="col-span-2 text-muted">{clock(e.ts)}</span>
                <span className={`col-span-1 ${resultTone[e.result] ?? "text-foreground"}`}>
                  {e.result}
                </span>
                <span className="col-span-1 text-info">{e.method}</span>
                <span className="col-span-4 text-foreground truncate">{e.path}</span>
                <span className="col-span-2 text-muted truncate">
                  {e.keyHash ? `${e.keyHash.slice(0, 8)}…` : "—"}
                  {e.scope ? <span className="text-muted">/{e.scope}</span> : null}
                </span>
                <span className="col-span-2 text-muted truncate">
                  {e.ip ?? "—"} {e.walletId ? `· ${shortId(e.walletId)}` : ""}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
