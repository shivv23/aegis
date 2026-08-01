"use client";

import { useState } from "react";
import { useStream } from "@/hooks/use-stream";
import { Button, Card, Field, Money, TxBadge } from "@/components/ui";
import { ownerApi } from "@/lib/api-client";
import { clock, shortId } from "@/lib/utils";
import { FlaskConical, Play, RotateCcw } from "lucide-react";
import type { RejectionReason, Transaction, WalletPolicy } from "@/core/types";

interface Decision {
  txId: string;
  amount: number;
  to: string;
  purpose: string;
  at: number;
  actual: Transaction["status"];
  wouldBe: "ALLOWED" | "BLOCKED";
  reason?: RejectionReason;
  details?: string;
}

interface Simulation {
  policy: WalletPolicy;
  decisions: Decision[];
  summary: {
    total: number;
    wouldSettle: number;
    wouldBlock: number;
    actuallyBlocked: number;
    newlyBlocked: number;
    previouslyBlockedNowAllowed: number;
  };
}

export default function SandboxPage() {
  const { wallets } = useStream();
  const [walletId, setWalletId] = useState<string>("");
  const [policy, setPolicy] = useState<WalletPolicy | null>(null);
  const [allowlist, setAllowlist] = useState("");
  const [result, setResult] = useState<Simulation | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const effectiveWalletId = walletId || (wallets[0]?.id ?? "");
  const effectiveWallet = wallets.find((w) => w.id === effectiveWalletId) ?? null;
  const effectivePolicy = policy ?? effectiveWallet?.policy ?? null;

  function pickWallet(nextId: string) {
    setWalletId(nextId);
    setPolicy(null);
    setAllowlist(wallets.find((w) => w.id === nextId)?.policy.allowlist.join(", ") ?? "");
    setResult(null);
  }

  function set<K extends keyof WalletPolicy>(key: K, value: WalletPolicy[K]) {
    setPolicy((prev) => ({ ...(prev ?? effectivePolicy!), [key]: value }));
  }

  async function simulate() {
    if (!effectiveWallet || !effectivePolicy) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const parsedAllowlist = allowlist
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const body = { ...effectivePolicy, allowlist: parsedAllowlist };
      const res = await ownerApi<Simulation>("/api/simulate", {
        method: "POST",
        body: JSON.stringify({ walletId: effectiveWallet.id, policy: body }),
      });
      setResult(res);
    } catch (e) {
      setErrorMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const summary = result?.summary;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-mono text-xl font-bold tracking-tight">Policy Sandbox</h1>
        <p className="text-sm text-muted">
          Replay a wallet&apos;s real history against a hypothetical policy. See exactly what
          the guard would have blocked — before you touch a real setting.
        </p>
      </header>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <Card className="space-y-4">
          <div className="flex items-center gap-2">
            <FlaskConical className="h-4 w-4 text-accent" />
            <span className="font-mono text-xs uppercase tracking-widest text-muted">
              Hypothetical policy
            </span>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-mono uppercase tracking-widest text-muted">
              Wallet to replay
            </span>
            <select
              value={effectiveWalletId}
              onChange={(e) => pickWallet(e.target.value)}
              className="rounded-md border border-border bg-black/40 px-3 py-2 text-sm text-foreground outline-none focus:border-accent/60 font-mono"
            >
              {wallets.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} — {shortId(w.id, 12)}
                </option>
              ))}
            </select>
          </label>

          {effectivePolicy ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field
                  label="Max per tx"
                  type="number"
                  value={effectivePolicy.maxPerTx}
                  onChange={(e) => set("maxPerTx", Number(e.target.value))}
                />
                <Field
                  label="Daily limit"
                  type="number"
                  value={effectivePolicy.dailyLimit}
                  onChange={(e) => set("dailyLimit", Number(e.target.value))}
                />
                <Field
                  label="Monthly limit"
                  type="number"
                  value={effectivePolicy.monthlyLimit}
                  onChange={(e) => set("monthlyLimit", Number(e.target.value))}
                />
                <Field
                  label="Velocity (/min)"
                  type="number"
                  value={effectivePolicy.velocityLimitPerMin}
                  onChange={(e) => set("velocityLimitPerMin", Number(e.target.value))}
                />
              </div>
              <Field
                label="Allowlist (comma-separated)"
                value={allowlist || (effectiveWallet?.policy.allowlist.join(", ") ?? "")}
                onChange={(e) => setAllowlist(e.target.value)}
              />
              <div className="flex gap-2">
                <Button onClick={simulate} disabled={busy || !effectiveWallet} className="flex-1">
                  <Play className="h-4 w-4" /> {busy ? "Replaying…" : "Replay history"}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setPolicy(null);
                    setAllowlist(effectiveWallet?.policy.allowlist.join(", ") ?? "");
                  }}
                >
                  <RotateCcw className="h-4 w-4" />
                </Button>
              </div>
            </>
          ) : null}
          {errorMsg ? (
            <div className="rounded border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-[11px] text-danger">
              {errorMsg}
            </div>
          ) : null}
        </Card>

        <div className="xl:col-span-2 space-y-4">
          {summary ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Card className="flex flex-col gap-1">
                <div className="text-[11px] font-mono uppercase tracking-widest text-muted">Replayed</div>
                <div className="font-mono text-2xl font-bold">{summary.total}</div>
                <div className="text-xs text-muted">transactions</div>
              </Card>
              <Card className="flex flex-col gap-1">
                <div className="text-[11px] font-mono uppercase tracking-widest text-muted">Would settle</div>
                <div className="font-mono text-2xl font-bold text-accent">{summary.wouldSettle}</div>
                <div className="text-xs text-muted">passed hypothetical guard</div>
              </Card>
              <Card className="flex flex-col gap-1">
                <div className="text-[11px] font-mono uppercase tracking-widest text-muted">Would block</div>
                <div className="font-mono text-2xl font-bold text-danger">{summary.wouldBlock}</div>
                <div className="text-xs text-muted">failed hypothetical guard</div>
              </Card>
              <Card className="flex flex-col gap-1">
                <div className="text-[11px] font-mono uppercase tracking-widest text-muted">Newly caught</div>
                <div className="font-mono text-2xl font-bold text-warn">{summary.newlyBlocked}</div>
                <div className="text-xs text-muted">settled before, blocked now</div>
              </Card>
            </div>
          ) : (
            <Card>
              <div className="py-16 text-center font-mono text-sm text-muted">
                Pick a wallet and a policy, then replay its real history.
              </div>
            </Card>
          )}

          {result ? (
            <Card className="p-0 overflow-hidden">
              <div className="px-4 py-3 border-b border-border font-mono text-xs uppercase tracking-widest text-muted">
                Replay — {result.decisions.length} decisions
              </div>
              <div className="max-h-[480px] overflow-y-auto">
                {result.decisions.map((d) => (
                  <div
                    key={d.txId}
                    className="grid grid-cols-12 gap-2 items-center px-4 py-2 border-b border-border/60 last:border-0 font-mono text-[11px]"
                  >
                    <span className="col-span-2 text-muted">{clock(d.at)}</span>
                    <span className="col-span-3">
                      <Money value={d.amount} /> → {shortId(d.to, 16)}
                    </span>
                    <span className="col-span-2 text-muted truncate">{d.purpose}</span>
                    <span className="col-span-2"><TxBadge status={d.actual} /></span>
                    <span className="col-span-1">
                      <span className={d.wouldBe === "ALLOWED" ? "text-accent" : "text-danger"}>
                        {d.wouldBe}
                      </span>
                    </span>
                    <span className="col-span-2 text-muted">{d.reason ?? ""}</span>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
