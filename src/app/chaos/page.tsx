"use client";

import { useMemo, useState } from "react";
import { useStream } from "@/hooks/use-stream";
import { Button, Card, Field, StatCard, TxBadge } from "@/components/ui";
import { runChaos } from "@/lib/api-client";
import { money, shortId } from "@/lib/utils";
import { Bomb, Loader2 } from "lucide-react";

interface ChaosResult {
  index: number;
  to: string;
  amount: number;
  status: string;
  reason?: string;
  latencyMs: number;
  purpose?: string;
}

interface ChaosResponse {
  chaosKey: string;
  mix: string;
  count: number;
  funnel: Record<string, number>;
  latency: { p50: number; p95: number; max: number; avg: number };
  breaker: { threshold: number; windowMs: number; anomalies: number; tripped: boolean };
  results: ChaosResult[];
}

export default function ChaosLabPage() {
  const { wallets } = useStream();
  const [walletId, setWalletId] = useState("wallet-tradingbot-42");
  const [count, setCount] = useState("20");
  const [mix, setMix] = useState<"valid" | "chaos" | "velocity">("chaos");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ChaosResponse | null>(null);

  const walletOptions = useMemo(
    () => wallets.filter((w) => w.id !== "wallet-tradingbot-42" || true),
    [wallets],
  );

  async function fire() {
    setBusy(true);
    setError(null);
    try {
      const res = await runChaos(walletId, Math.min(120, Math.max(1, Number(count) || 20)), mix);
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chaos run failed");
    } finally {
      setBusy(false);
    }
  }

  const funnel = result?.funnel ?? {};
  const counts = {
    settled: funnel.settled ?? 0,
    pending: funnel.pending ?? 0,
    stepUp: funnel.stepuprequired ?? 0,
    blocked: funnel.blocked ?? 0,
    error: funnel.error ?? 0,
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-mono text-xl font-bold tracking-tight">Chaos Lab</h1>
        <p className="text-sm text-muted">
          Fire a concurrent burst of transfers and watch the guard, velocity cap,
          and circuit breaker react live.
        </p>
      </header>

      <Card>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 items-end">
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-mono uppercase tracking-widest text-muted">
              Wallet
            </span>
            <select
              value={walletId}
              onChange={(e) => setWalletId(e.target.value)}
              className="rounded-md border border-border bg-black/40 px-3 py-2 text-sm text-foreground outline-none focus:border-accent/60 font-mono"
            >
              {walletOptions.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.id}
                </option>
              ))}
            </select>
          </div>
          <Field
            label="Concurrent transfers"
            type="number"
            min={1}
            max={120}
            value={count}
            onChange={(e) => setCount(e.target.value)}
          />
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-mono uppercase tracking-widest text-muted">
              Mix
            </span>
            <select
              value={mix}
              onChange={(e) => setMix(e.target.value as "valid" | "chaos" | "velocity")}
              className="rounded-md border border-border bg-black/40 px-3 py-2 text-sm text-foreground outline-none focus:border-accent/60 font-mono"
            >
              <option value="chaos">chaos — pass / block / step-up</option>
              <option value="velocity">velocity — hammer the cap + breaker</option>
              <option value="valid">valid — mostly passes</option>
            </select>
          </div>
          <Button variant="danger" onClick={() => void fire()} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bomb className="h-4 w-4" />}
            {busy ? "Firing…" : "Fire transfers"}
          </Button>
        </div>
        <p className="mt-3 text-[11px] text-muted">
          mix=velocity hammers the velocity limit and circuit breaker; mix=chaos
          mixes passes, blocks, and step-ups. Every transfer runs through the same
          guard as production.
        </p>
      </Card>

      {error ? (
        <div className="rounded-md border border-danger/40 bg-danger/10 px-4 py-2 font-mono text-xs text-danger">
          {error}
        </div>
      ) : null}

      {result ? (
        <div className="space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
            <StatCard label="Settled" value={String(counts.settled)} tone="accent" />
            <StatCard label="Pending" value={String(counts.pending)} tone="warn" />
            <StatCard label="Step-up" value={String(counts.stepUp)} tone="warn" />
            <StatCard label="Blocked" value={String(counts.blocked)} tone="danger" />
            <StatCard label="Errors" value={String(counts.error)} tone="danger" />
            <StatCard
              label="Latency p50 / p95"
              value={`${result.latency.p50}ms / ${result.latency.p95}ms`}
              sub={`max ${result.latency.max}ms · avg ${result.latency.avg}ms`}
              tone="info"
            />
          </div>

          <Card
            className={
              result.breaker.tripped
                ? "border-danger/50"
                : "border-accent/30"
            }
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="font-mono text-xs uppercase tracking-widest text-muted">
                  Circuit breaker
                </div>
                <div className="mt-1 font-mono text-sm">
                  {result.breaker.tripped ? (
                    <span className="text-danger">TRIPPED — wallet auto-frozen on anomalies</span>
                  ) : (
                    <span className="text-accent">HEALTHY — {result.breaker.anomalies} anomalies in window</span>
                  )}
                </div>
              </div>
              <div className="font-mono text-[11px] text-muted">
                threshold {result.breaker.anomalies}/{result.breaker.threshold} within{" "}
                {Math.round(result.breaker.windowMs / 1000)}s
              </div>
            </div>
          </Card>

          <div className="rounded-xl border border-border bg-panel/70 overflow-hidden">
            <div className="grid grid-cols-12 gap-2 px-4 py-2.5 border-b border-border font-mono text-[10px] uppercase tracking-widest text-muted">
              <span className="col-span-1">#</span>
              <span className="col-span-3">To</span>
              <span className="col-span-2">Amount</span>
              <span className="col-span-3">Purpose</span>
              <span className="col-span-1">Status</span>
              <span className="col-span-2 text-right">Latency</span>
            </div>
            <div className="max-h-[400px] overflow-y-auto">
              {result.results.map((r) => (
                <div
                  key={r.index}
                  className="grid grid-cols-12 gap-2 items-center px-4 py-2 border-b border-border/60 last:border-0 hover:bg-white/[0.03] font-mono text-xs"
                >
                  <span className="col-span-1 text-muted">{r.index}</span>
                  <span className="col-span-3 text-info truncate">{shortId(r.to, 24)}</span>
                  <span className="col-span-2">{money(r.amount)}</span>
                  <span className="col-span-3 text-muted truncate">{r.purpose}</span>
                  <span className="col-span-1">
                    <TxBadge status={(r.status as "SETTLED" | "PENDING" | "BLOCKED" | "REVOKED" | "STEP_UP_REQUIRED")} />
                  </span>
                  <span className="col-span-2 text-right text-muted">{r.latencyMs}ms</span>
                </div>
              ))}
            </div>
          </div>

          <p className="font-mono text-[11px] text-muted">
            run {result.chaosKey} · mix={result.mix} · {result.count} transfers
          </p>
        </div>
      ) : (
        <Card>
          <div className="flex items-center gap-3 text-muted font-mono text-sm">
            <Bomb className="h-4 w-4" />
            No run yet — pick a wallet and fire a burst.
          </div>
        </Card>
      )}
    </div>
  );
}
