"use client";

import { useEffect, useState } from "react";
import { ownerApi } from "@/lib/api-client";
import { Card } from "@/components/ui";
import { BarChart3, TrendingUp, ShieldAlert, Flame } from "lucide-react";

interface Analytics {
  funnel: {
    total: number;
    settled: number;
    blocked: number;
    pending: number;
    revoked: number;
    stepUp: number;
    settledUsd: number;
  };
  blockedReasons: Record<string, number>;
  dailySpend: Array<{ day: string; settled: number; blocked: number }>;
  byPurpose: Array<{ purpose: string; count: number; usd: number; blocked: number }>;
  budgets: Array<{
    groupId: string;
    name: string;
    monthlyLimit: number;
    spend: number;
    burnPct: number;
    ratePerDay: number;
    runwayDays: number | null;
    projectedPct: number;
    status: "on_track" | "warning" | "exhausted";
    walletCount: number;
    series: Array<{ day: string; spend: number; limit: number }>;
  }>;
}

const COLORS = ["bg-emerald-500", "bg-sky-500", "bg-amber-500", "bg-rose-500", "bg-violet-500"];

function Bars({ data }: { data: Array<{ label: string; value: number; sub?: string }> }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="flex h-36 items-end gap-3">
      {data.map((d, i) => (
        <div key={i} className="flex flex-1 flex-col items-center gap-1">
          <span className="font-mono text-[10px] text-zinc-500">{d.sub ?? String(d.value)}</span>
          <div className={`w-full max-w-10 rounded-t ${COLORS[i % COLORS.length]}`} style={{ height: `${(d.value / max) * 100}%` }} />
          <span className="font-mono text-[10px] text-zinc-500">{d.label}</span>
        </div>
      ))}
    </div>
  );
}

export default function AnalyticsPage() {
  const [a, setA] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    ownerApi<Analytics>("/api/analytics")
      .then((d) => {
        if (!active) return;
        setA(d);
        setError(null);
      })
      .catch((e) => {
        if (active) setError((e as Error).message);
      });
    return () => {
      active = false;
    };
  }, []);

  if (error) return <div className="mx-auto max-w-3xl px-6 py-10 text-sm text-rose-400">{error}</div>;

  const f = a?.funnel;

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-6 py-10">
      <div>
        <p className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-zinc-400">
          <BarChart3 size={14} /> Guard Analytics
        </p>
        <h1 className="font-mono text-2xl font-bold text-zinc-100">What the guard is doing</h1>
      </div>

      {f && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {[
            { label: "Settled", value: f.settled, sub: `$${f.settledUsd}` },
            { label: "Blocked", value: f.blocked },
            { label: "Pending", value: f.pending },
            { label: "Revoked", value: f.revoked },
            { label: "Step-up", value: f.stepUp },
            { label: "Total", value: f.total },
          ].map((k) => (
            <Card key={k.label} className="p-4">
              <div className="font-mono text-2xl font-bold text-zinc-100">{k.value}</div>
              <div className="text-xs text-zinc-500">
                {k.label}
                {k.sub ? <span className="ml-1 text-emerald-400">{k.sub}</span> : null}
              </div>
            </Card>
          ))}
        </div>
      )}

      {a && (
        <>
          <section>
            <h2 className="mb-3 flex items-center gap-2 font-mono text-sm font-semibold text-zinc-200">
              <TrendingUp size={15} className="text-emerald-400" /> Settled vs blocked — last 7 days
            </h2>
            <Card className="p-4">
              <Bars
                data={a.dailySpend.map((d) => ({ label: d.day, value: d.settled + d.blocked, sub: `$${d.settled}` }))}
              />
            </Card>
          </section>

          <section>
            <h2 className="mb-3 flex items-center gap-2 font-mono text-sm font-semibold text-zinc-200">
              <ShieldAlert size={15} className="text-rose-400" /> Why transfers were blocked
            </h2>
            <Card className="p-4">
              {Object.keys(a.blockedReasons).length === 0 ? (
                <p className="text-sm text-zinc-500">No blocks recorded yet.</p>
              ) : (
                <Bars
                  data={Object.entries(a.blockedReasons).map(([reason, n]) => ({
                    label: reason.replace("_EXCEEDED", "").toLowerCase(),
                    value: n,
                  }))}
                />
              )}
            </Card>
          </section>

          <section>
            <h2 className="mb-3 flex items-center gap-2 font-mono text-sm font-semibold text-zinc-200">
              <Flame size={15} className="text-amber-400" /> Budget burn-down &amp; runway
            </h2>
            <div className="grid gap-3">
              {a.budgets.length === 0 ? (
                <Card className="p-4">
                  <p className="text-sm text-zinc-500">
                    No budget groups yet. Create one on the Delegation page to see runway forecasts here.
                  </p>
                </Card>
              ) : (
                a.budgets.map((b) => {
                  const pill =
                    b.status === "exhausted"
                      ? "bg-rose-500/15 text-rose-400"
                      : b.status === "warning"
                        ? "bg-amber-500/15 text-amber-400"
                        : "bg-emerald-500/15 text-emerald-400";
                  const bar =
                    b.status === "exhausted"
                      ? "bg-rose-500"
                      : b.status === "warning"
                        ? "bg-amber-500"
                        : "bg-emerald-500";
                  const runway =
                    b.runwayDays === null
                      ? "no spend yet"
                      : b.runwayDays <= 0
                        ? "limit reached"
                        : `${b.runwayDays.toFixed(1)} days`;
                  return (
                    <Card key={b.groupId} className="p-4">
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm font-semibold text-zinc-100">{b.name}</span>
                          <span className="font-mono text-[10px] text-zinc-500">{b.walletCount} wallet{b.walletCount === 1 ? "" : "s"}</span>
                        </div>
                        <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${pill}`}>
                          {b.status.replace("_", " ")}
                        </span>
                      </div>
                      <div className="mb-1 flex items-baseline justify-between font-mono text-xs text-zinc-500">
                        <span>
                          ${b.spend.toFixed(2)} / ${b.monthlyLimit.toFixed(2)} spent
                        </span>
                        <span>
                          runway: <span className="text-zinc-200">{runway}</span> · projected{" "}
                          <span className={b.projectedPct >= 0.8 ? "text-amber-400" : "text-zinc-200"}>
                            {(b.projectedPct * 100).toFixed(0)}%
                          </span>{" "}
                          of limit
                        </span>
                      </div>
                      <div className="h-2 w-full overflow-hidden rounded bg-zinc-800">
                        <div className={`h-full rounded ${bar}`} style={{ width: `${(b.burnPct * 100).toFixed(0)}%` }} />
                      </div>
                      <Bars
                        data={b.series.map((d) => ({ label: d.day, value: d.spend, sub: `$${d.spend}` }))}
                      />
                    </Card>
                  );
                })
              )}
            </div>
          </section>

          <section>
            <h2 className="mb-3 font-mono text-sm font-semibold text-zinc-200">Spend by purpose</h2>
            <Card className="divide-y divide-zinc-800 p-0">
              {a.byPurpose.map((p, i) => (
                <div key={p.purpose} className="flex items-center justify-between px-5 py-2.5">
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-xs text-zinc-600">{String(i + 1).padStart(2, "0")}</span>
                    <span className="font-mono text-sm text-zinc-300">{p.purpose || "(unlabeled)"}</span>
                  </div>
                  <div className="font-mono text-xs text-zinc-400">
                    <span className="text-emerald-400">${p.usd}</span>
                    <span className="ml-2 text-zinc-600">{p.count} tx{p.blocked ? ` · ${p.blocked} blocked` : ""}</span>
                  </div>
                </div>
              ))}
            </Card>
          </section>
        </>
      )}
    </div>
  );
}
