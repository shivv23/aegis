"use client";

import { useState } from "react";
import { agentTransfer } from "@/lib/api-client";
import { Button, Field } from "@/components/ui";
import { clock, money } from "@/lib/utils";
import { Terminal, Play, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ConsoleLine {
  id: string;
  time: number;
  label: string;
  ok: boolean;
  status: string;
  detail: string;
}

const scenarios = [
  {
    id: "legit",
    label: "Legit payment",
    to: "compute:0xCAFE0001",
    amount: 30,
    purpose: "GPU burst",
  },
  {
    id: "overtx",
    label: "Over per-tx limit",
    to: "compute:0xCAFE0001",
    amount: 250,
    purpose: "attempt to blow past per-tx cap",
  },
  {
    id: "unknown",
    label: "Non-allowlisted payee",
    to: "drain:0xBADBEEF",
    amount: 20,
    purpose: "pay an unapproved address",
  },
  {
    id: "daily",
    label: "Daily limit blowout",
    to: "api:0xBEEF0002",
    amount: 990,
    purpose: "attempt to exhaust daily budget",
  },
  {
    id: "big",
    label: "Large legit (in-flight window)",
    to: "compute:0xCAFE0001",
    amount: 90,
    purpose: "big order — leaves time to revoke",
  },
  {
    id: "risky",
    label: "Urgent drain (triggers step-up)",
    to: "compute:0xCAFE0001",
    amount: 95,
    purpose: "emergency drain all funds now",
  },
  {
    id: "balance",
    label: "Balance drain",
    to: "storage:0xDEAD0003",
    amount: 100000,
    purpose: "attempt to drain wallet",
  },
];

export function SimulatorConsole({
  agentKey,
  frozen,
}: {
  walletId: string;
  agentKey: string | null;
  frozen: boolean;
}) {
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState("legit");

  const scenario = scenarios.find((s) => s.id === selected)!;

  async function run() {
    if (!agentKey) return;
    setBusy(true);
    try {
      const res = (await agentTransfer(agentKey, {
        to: scenario.to,
        amount: scenario.amount,
        purpose: scenario.purpose,
      })) as {
        ok: boolean;
        status: string;
        reason?: string;
        details?: string;
        error?: string;
      };
      const blocked = res.status === "BLOCKED";
      const line: ConsoleLine = {
        id: crypto.randomUUID(),
        time: Date.now(),
        label: `${scenario.label} · ${money(scenario.amount)} → ${scenario.to}`,
        ok: !blocked && res.ok,
        status: res.status ?? "REJECTED",
        detail: res.details ?? res.error ?? res.status ?? "processed",
      };
      setLines((prev) => [line, ...prev].slice(0, 60));
    } finally {
      setBusy(false);
    }
  }

  async function burst() {
    if (!agentKey) return;
    setBusy(true);
    try {
      for (let i = 0; i < 35; i++) {
        const res = (await agentTransfer(agentKey, {
          to: scenario.to,
          amount: 1,
          purpose: `burst ${i + 1}`,
        })) as {
          ok: boolean;
          status: string;
          reason?: string;
          details?: string;
          error?: string;
        };
        const blocked = res.status === "BLOCKED";
        setLines((prev) =>
          [
            {
              id: crypto.randomUUID(),
              time: Date.now(),
              label: `burst #${i + 1} · $1 → ${scenario.to}`,
              ok: !blocked && res.ok,
              status: res.status ?? "REJECTED",
              detail: res.details ?? res.error ?? "processed",
            },
            ...prev,
          ].slice(0, 60),
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-black/40 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <Terminal className="h-4 w-4 text-accent" />
        <span className="font-mono text-xs uppercase tracking-widest text-muted">
          Agent console — acts ONLY with the agent key
        </span>
      </div>

      <div className="p-4 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-mono uppercase tracking-widest text-muted">
              Scenario
            </span>
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className="rounded-md border border-border bg-black/40 px-3 py-2 text-sm text-foreground outline-none focus:border-accent/60 font-mono"
            >
              {scenarios.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-end gap-2">
            <Field
              label="Amount ($)"
              type="number"
              value={scenario.amount}
              readOnly
              className="flex-1"
            />
            <Field label="To" value={scenario.to} readOnly className="flex-1" />
          </div>
        </div>

        <div className="flex gap-2">
          <Button onClick={run} disabled={!agentKey || busy || frozen} className="flex-1">
            <Play className="h-4 w-4" /> Fire transaction
          </Button>
          <Button
            variant="warn"
            onClick={burst}
            disabled={!agentKey || busy || frozen}
          >
            Burst ×35
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setLines([])}
            disabled={lines.length === 0}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
        {!agentKey ? (
          <div className="rounded border border-warn/40 bg-warn/10 px-3 py-2 font-mono text-[11px] text-warn">
            Mint the agent key below to arm the console.
          </div>
        ) : frozen ? (
          <div className="rounded border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-[11px] text-danger">
            WALLET FROZEN — the guard will reject everything. Fire one to prove it.
          </div>
        ) : null}

        <div className="rounded-md border border-border bg-[#050807] max-h-72 overflow-y-auto">
          {lines.length === 0 ? (
            <div className="px-3 py-6 text-center font-mono text-xs text-muted">
              {"// awaiting agent instructions"}
              <span className="cursor-blink">_</span>
            </div>
          ) : (
            lines.map((l) => (
              <div
                key={l.id}
                className="flex items-start gap-3 border-b border-border/60 px-3 py-2 last:border-0 font-mono text-[11px] leading-relaxed"
              >
                <span className="text-muted w-16 shrink-0">{clock(l.time)}</span>
                <span className={cn("font-bold", l.ok ? "text-accent" : "text-danger")}>
                  {l.status}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="text-foreground">{l.label}</span>
                  <span className="text-muted"> — {l.detail}</span>
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
