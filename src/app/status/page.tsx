"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui";
import { Activity, Database, ShieldCheck } from "lucide-react";

interface Health {
  status: string;
  checks: {
    ledger: { intact: boolean; rows: number };
    db: boolean;
  };
  uptime: number;
  ts: number;
}

export default function StatusPage() {
  const [h, setH] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/health")
      .then(async (r) => {
        const d = (await r.json()) as Health;
        if (!active) return;
        setH(d);
        setError(null);
      })
      .catch((e) => {
        if (active) setError((e as Error).message);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">System status</h1>
        <p className="text-sm text-zinc-500">Liveness + readiness of the enforcement layer.</p>
      </div>

      {error && <p className="text-sm text-rose-500">{error}</p>}

      {h && (
        <div className="space-y-4">
          <Card className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className={h.status === "ok" ? "text-emerald-500" : "text-rose-500"}>
                <ShieldCheck className="h-5 w-5" />
              </span>
              <div>
                <div className="text-sm font-medium uppercase tracking-wider">
                  {h.status === "ok" ? "Operational" : "Degraded"}
                </div>
                <div className="font-mono text-xs text-zinc-500">
                  uptime {Math.round(h.uptime)}s · {new Date(h.ts).toISOString()}
                </div>
              </div>
            </div>
            <span className="font-mono text-xs text-zinc-400">/api/health</span>
          </Card>

          <div className="grid gap-4 sm:grid-cols-2">
            <Card className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Database className="h-5 w-5 text-sky-500" />
                <div>
                  <div className="text-sm font-medium">Ledger</div>
                  <div className="font-mono text-xs text-zinc-500">
                    {h.checks.ledger.rows} chained rows
                  </div>
                </div>
              </div>
              <span className={`rounded px-2 py-0.5 font-mono text-xs ${h.checks.ledger.intact ? "bg-emerald-500/15 text-emerald-500" : "bg-rose-500/15 text-rose-500"}`}>
                {h.checks.ledger.intact ? "INTACT" : "BROKEN"}
              </span>
            </Card>
            <Card className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Activity className="h-5 w-5 text-violet-500" />
                <div>
                  <div className="text-sm font-medium">Database</div>
                  <div className="font-mono text-xs text-zinc-500">readiness probe</div>
                </div>
              </div>
              <span className={`rounded px-2 py-0.5 font-mono text-xs ${h.checks.db ? "bg-emerald-500/15 text-emerald-500" : "bg-rose-500/15 text-rose-500"}`}>
                {h.checks.db ? "READY" : "DOWN"}
              </span>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
