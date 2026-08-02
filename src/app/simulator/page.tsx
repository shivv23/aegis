"use client";

import { useMemo, useState } from "react";
import { useStream } from "@/hooks/use-stream";
import { Button, Card, Field, WalletBadge } from "@/components/ui";
import { agentTransfer, mintKeys } from "@/lib/api-client";
import { clock, money, shortId } from "@/lib/utils";
import { Bomb, Send } from "lucide-react";

interface Attack {
  id: string;
  label: string;
  to: string;
  amount: number;
  purpose: string;
}

export default function SimulatorPage() {
  const { wallets } = useStream();
  const [walletId, setWalletId] = useState<string>("");
  const [agentKey, setAgentKey] = useState<string | null>(null);
  const [to, setTo] = useState("compute:0xCAFE0001");
  const [amount, setAmount] = useState("30");
  const [purpose, setPurpose] = useState("agent-transfer");
  const [response, setResponse] = useState<{ ok: boolean; data: unknown } | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const selected = useMemo(
    () => wallets.find((w) => w.id === walletId) ?? null,
    [wallets, walletId],
  );

  const attacks: Attack[] = [
    { id: "overtx", label: "Blow past per-tx cap", to: "compute:0xCAFE0001", amount: 500, purpose: "attempt: exceed per-tx cap" },
    { id: "unknown", label: "Pay unapproved address", to: "drain:0xBADBEEF", amount: 25, purpose: "attempt: unapproved payee" },
    { id: "drain", label: "Drain full balance", to: "storage:0xDEAD0003", amount: 999999, purpose: "attempt: drain wallet" },
    { id: "daily", label: "Exhaust daily budget", to: "api:0xBEEF0002", amount: 990, purpose: "attempt: exhaust daily budget" },
  ];

  async function arm() {
    if (!walletId) return;
    const k = await mintKeys(walletId);
    setAgentKey(k.agentKey);
    pushLog(`> armed agent key for ${shortId(walletId)}`);
  }

  function pushLog(line: string) {
    setLog((prev) => [`[${clock(Date.now())}] ${line}`, ...prev].slice(0, 40));
  }

  async function fire(a: { to: string; amount: number; purpose: string }) {
    if (!agentKey) return;
    const res = (await agentTransfer(agentKey, a)) as {
      ok: boolean;
      status: string;
      reason?: string;
      details?: string;
      error?: string;
      message?: string;
      transaction?: { id: string; status: string };
    };
    setResponse({ ok: res.ok, data: res });
    const verdict = res.status ?? "REJECTED";
    pushLog(`${money(a.amount)} → ${a.to} : ${verdict}${res.reason ? ` (${res.reason})` : ""}`);
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-mono text-xl font-bold tracking-tight">Agent Simulator</h1>
        <p className="text-sm text-muted">
          Assume the role of a compromised agent. Attack the wallet through the
          real API — and watch the guard, not the agent, decide what happens.
        </p>
      </header>

      <Card className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-mono uppercase tracking-widest text-muted">
              Target wallet
            </span>
            <select
              value={walletId}
              onChange={(e) => setWalletId(e.target.value)}
              className="rounded-md border border-border bg-black/40 px-3 py-2 text-sm font-mono text-foreground outline-none focus:border-accent/60"
            >
              <option value="">select…</option>
              {wallets.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} · {shortId(w.id)}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-end">
            <Button onClick={arm} disabled={!walletId} className="w-full">
              Arm agent key
            </Button>
          </div>
          <div className="flex items-center justify-center rounded-md border border-border bg-black/30 px-3 py-2">
            {agentKey ? (
              <span className="font-mono text-[11px] text-accent">
                ✓ AGENT KEY LOADED — scope: agent
              </span>
            ) : (
              <span className="font-mono text-[11px] text-muted">
                awaiting agent key…
              </span>
            )}
          </div>
        </div>

        {selected ? (
          <div className="flex flex-wrap gap-2">
            {attacks.map((a) => (
              <Button key={a.id} variant="danger" size="sm" disabled={!agentKey} onClick={() => fire(a)}>
                <Bomb className="h-3.5 w-3.5" /> {a.label}
              </Button>
            ))}
          </div>
        ) : null}
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <Card className="space-y-3">
          <div className="font-mono text-xs uppercase tracking-widest text-muted">
            Custom transfer — POST /api/rail/transfer
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="To" value={to} onChange={(e) => setTo(e.target.value)} />
            <Field label="Amount ($)" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <Field label="Purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} />
          <Button
            variant="primary"
            disabled={!agentKey}
            onClick={() => fire({ to, amount: Number(amount), purpose })}
          >
            <Send className="h-4 w-4" /> Fire transfer
          </Button>

          <div>
            <div className="mb-1.5 text-[11px] font-mono uppercase tracking-widest text-muted">
              Raw API response
            </div>
            <pre className="overflow-x-auto rounded-md border border-border bg-black/50 px-3 py-2 text-xs font-mono text-info">
              {response ? JSON.stringify(response.data, null, 2) : "// no request yet"}
            </pre>
          </div>
        </Card>

        <div>
          <div className="mb-2 font-mono text-xs uppercase tracking-widest text-muted">
            Attack log
          </div>
          <div className="rounded-xl border border-border bg-black/40 overflow-hidden">
            <div className="max-h-[420px] overflow-y-auto font-mono text-[11px]">
              {log.length === 0 ? (
                <div className="px-4 py-10 text-center text-muted">
                  {"// no attacks attempted"}
                  <span className="cursor-blink">_</span>
                </div>
              ) : (
                log.map((line, i) => (
                  <div
                    key={i}
                    className={`border-b border-border/60 px-3 py-2 last:border-0 leading-relaxed ${
                      line.includes("BLOCKED") ? "text-danger" : "text-foreground"
                    }`}
                  >
                    {line}
                  </div>
                ))
              )}
            </div>
          </div>
          {selected ? (
            <div className="mt-3 flex items-center justify-between rounded-md border border-border bg-panel/70 px-4 py-3">
              <span className="font-mono text-xs text-muted">wallet status</span>
              <WalletBadge status={selected.status} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
