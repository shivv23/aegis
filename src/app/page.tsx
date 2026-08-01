"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useStream } from "@/hooks/use-stream";
import { Button, Card, StatCard, WalletBadge } from "@/components/ui";
import { LiveFeed } from "@/components/live-feed";
import { ownerApi } from "@/lib/api-client";
import { money, shortId } from "@/lib/utils";
import { Snowflake, Zap, Siren, RotateCcw } from "lucide-react";

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export default function CommandCenter() {
  const { transactions, wallets, connected, error } = useStream();
  const router = useRouter();
  const now = useNow();

  const stats = useMemo(() => {
    const dayAgo = now - 24 * 60 * 60 * 1000;
    const settled = transactions.filter((t) => t.status === "SETTLED");
    const volumeToday = settled
      .filter((t) => t.settledAt && t.settledAt > dayAgo)
      .reduce((s, t) => s + t.amount, 0);
    return {
      active: wallets.filter((w) => w.status === "ACTIVE").length,
      frozen: wallets.filter((w) => w.status === "FROZEN").length,
      volumeToday,
      blocked: transactions.filter((t) => t.status === "BLOCKED").length,
      revoked: transactions.filter((t) => t.status === "REVOKED").length,
    };
  }, [transactions, wallets, now]);

  async function toggleFreeze(id: string, frozen: boolean) {
    await ownerApi(`/api/wallet/${id}/${frozen ? "unfreeze" : "freeze"}`, {
      method: "POST",
    });
    router.refresh();
  }

  async function resetDemo() {
    await ownerApi("/api/admin/reset", { method: "POST" });
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="font-mono text-xl font-bold tracking-tight">
            Command Center
          </h1>
          <p className="text-sm text-muted">
            Wallet-layer enforcement for autonomous agents. Agents cannot
            outrun their policy.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={resetDemo} title="Reset demo data">
            <RotateCcw className="h-3.5 w-3.5" /> Reset demo
          </Button>
          <span
            className={`h-2 w-2 rounded-full ${
              connected ? "bg-accent" : "bg-danger"
            }`}
          />
          <span className="font-mono text-[11px] text-muted">
            {connected ? "STREAM LIVE" : "RECONNECTING"}
          </span>
        </div>
      </header>

      {error ? (
        <div className="rounded-md border border-danger/40 bg-danger/10 px-4 py-2 font-mono text-xs text-danger">
          {error}
        </div>
      ) : null}

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
        <StatCard label="Wallets" value={String(wallets.length)} sub={`${stats.active} active`} />
        <StatCard label="Frozen" value={String(stats.frozen)} sub="kill switch engaged" tone="danger" />
        <StatCard label="Volume (24h)" value={money(stats.volumeToday)} sub="settled only" tone="accent" />
        <StatCard label="Blocked attempts" value={String(stats.blocked)} sub="guard rejected" tone="warn" />
        <StatCard label="Revoked in-flight" value={String(stats.revoked)} sub="mid-transaction" tone="info" />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">
        <div className="xl:col-span-3">
          <LiveFeed transactions={transactions} />
        </div>

        <div className="xl:col-span-2 space-y-4">
          <Card className="flex items-center justify-between border-accent/30">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/15 border border-accent/40">
                <Siren className="h-5 w-5 text-accent" />
              </div>
              <div>
                <div className="font-mono text-sm font-semibold">
                  Guard is independent
                </div>
                <div className="text-xs text-muted">
                  Policy enforced at wallet layer. Even a hostile agent is
                  capped by construction.
                </div>
              </div>
            </div>
          </Card>

          <div>
            <div className="mb-2 font-mono text-xs uppercase tracking-widest text-muted">
              Wallets
            </div>
            <div className="space-y-3">
              {wallets.length === 0 ? (
                <Card>
                  <div className="font-mono text-sm text-muted">
                    No wallets yet. Create one from the Wallet Registry.
                  </div>
                </Card>
              ) : (
                wallets.map((w) => (
                  <Card key={w.id} className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <button
                        className="text-left group"
                        onClick={() => router.push(`/wallet/${w.id}`)}
                      >
                        <div className="font-mono text-sm font-semibold group-hover:text-accent">
                          {w.name}
                        </div>
                        <div className="font-mono text-[11px] text-muted">
                          {shortId(w.id)}
                        </div>
                      </button>
                      <WalletBadge status={w.status} />
                    </div>
                    <div className="mt-3 flex items-center justify-between">
                      <div>
                        <div className="text-[10px] font-mono uppercase tracking-widest text-muted">
                          Balance
                        </div>
                        <div className="font-mono text-lg font-bold">
                          {money(w.balance)}
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => router.push(`/wallet/${w.id}`)}
                        >
                          Manage
                        </Button>
                        {w.status === "FROZEN" ? (
                          <Button
                            variant="warn"
                            size="sm"
                            onClick={() => toggleFreeze(w.id, true)}
                          >
                            <Zap className="h-3.5 w-3.5" /> Unfreeze
                          </Button>
                        ) : (
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => toggleFreeze(w.id, false)}
                          >
                            <Snowflake className="h-3.5 w-3.5" /> Freeze
                          </Button>
                        )}
                      </div>
                    </div>
                  </Card>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
