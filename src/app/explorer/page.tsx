"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ownerApi } from "@/lib/api-client";
import { Button, Card } from "@/components/ui";
import { clock, money, shortId } from "@/lib/utils";
import { ExternalLink, RefreshCw, Route } from "lucide-react";
import type { Transaction } from "@/core/types";

interface RefInfo {
  label: string;
  tone: string;
  hint: string;
}

function classifyRef(tx: Transaction): RefInfo {
  const ref = tx.externalRef ?? "";
  if (ref.startsWith("local://")) {
    return {
      label: "in-process (sandbox)",
      tone: "text-info",
      hint: "Settles inside the app — no real money moves.",
    };
  }
  if (ref.startsWith("ach://")) {
    return {
      label: "bank rail (mock)",
      tone: "text-warn",
      hint: "Synthetic bank reference — no real ACH gateway exists.",
    };
  }
  if (/^0x[0-9a-f]{40}$/.test(ref)) {
    return {
      label: "on-chain style (usdc-testnet)",
      tone: "text-emerald-400",
      hint: "Deterministic simulated reference — a Circle key would make this a real testnet tx.",
    };
  }
  return {
    label: tx.rail ?? "unknown",
    tone: "text-muted",
    hint: "Settlement reference recorded by the rail.",
  };
}

export default function ExplorerPage() {
  const [txs, setTxs] = useState<Transaction[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await ownerApi<{ transactions: Transaction[] }>(
        "/api/transactions?limit=200",
      );
      setTxs(data.transactions ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "ledger unavailable");
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const settled = useMemo(() => (txs ?? []).filter((t) => t.status === "SETTLED"), [txs]);

  const byRail = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of settled) {
      const key = classifyRef(t).label;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()];
  }, [settled]);

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 font-mono text-xl font-bold tracking-tight">
            <Route className="h-5 w-5 text-accent" />
            Settlement explorer
          </h1>
          <p className="text-sm text-muted">
            Every settled transfer&apos;s settlement reference, rendered as a
            trace. References are honest about what moved: in-process refs,
            mock bank refs, and on-chain-style refs are all labeled.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh}>
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </Button>
      </header>

      <div className="rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-xs text-warn font-mono">
        No gateway keys are configured in this deployment — every rail below
        reports simulated: true. Labels say exactly what each reference means.
      </div>

      {error ? (
        <div className="rounded-xl border border-border bg-panel/70 px-4 py-8 text-center font-mono text-sm text-warn">
          {error}
        </div>
      ) : txs === null ? (
        <div className="rounded-xl border border-border bg-panel/70 px-4 py-10 text-center font-mono text-sm text-muted">
          reading…
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-3">
            {byRail.map(([label, count]) => (
              <Card key={label} className="px-4 py-3">
                <div className="font-mono text-[10px] uppercase tracking-widest text-muted">
                  {label}
                </div>
                <div className="font-mono text-2xl font-bold">{count}</div>
              </Card>
            ))}
          </div>

          <div className="rounded-xl border border-border bg-panel/70 overflow-hidden">
            <div className="grid grid-cols-12 gap-2 px-4 py-2.5 border-b border-border font-mono text-[10px] uppercase tracking-widest text-muted">
              <span className="col-span-3">Settled</span>
              <span className="col-span-3">Amount → payee</span>
              <span className="col-span-4">Reference</span>
              <span className="col-span-2 text-right">Rail</span>
            </div>
            {settled.length === 0 ? (
              <div className="px-4 py-10 text-center font-mono text-sm text-muted">
                no settled transfers yet
              </div>
            ) : (
              settled.map((t) => {
                const info = classifyRef(t);
                return (
                  <div
                    key={t.id}
                    className="grid grid-cols-12 gap-2 items-center px-4 py-2.5 border-b border-border/60 last:border-0 font-mono text-xs"
                  >
                    <span className="col-span-3 text-muted">{clock(t.settledAt ?? t.requestedAt)}</span>
                    <span className="col-span-3 text-foreground">
                      {money(t.amount)} <span className="text-muted">→</span>{" "}
                      <span className="text-accent">{shortId(t.to)}</span>
                    </span>
                    <span className="col-span-4 flex items-center gap-2 min-w-0">
                      <span className="truncate text-info">{t.externalRef ?? "—"}</span>
                      <span className="group relative cursor-help">
                        <ExternalLink className="h-3 w-3 text-muted shrink-0" />
                        <span className="pointer-events-none absolute left-0 top-full z-10 mt-1 hidden w-56 rounded-md border border-border bg-black/95 px-2 py-1.5 text-[10px] text-muted group-hover:block">
                          {info.hint}
                        </span>
                      </span>
                    </span>
                    <span className={`col-span-2 text-right ${info.tone}`}>{info.label}</span>
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
}
