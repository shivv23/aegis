"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Field } from "@/components/ui";
import { ownerApi } from "@/lib/api-client";
import { RefreshCw, Network } from "lucide-react";
import type { BudgetGroup, Organization, Wallet } from "@/core/types";

interface WalletNode extends Wallet {
  effective: Wallet | null;
}

interface TeamNode extends BudgetGroup {
  wallets: WalletNode[];
}

interface OrgNode extends Organization {
  teams: TeamNode[];
  unassignedWallets: WalletNode[];
}

const FIELDS: { key: string; label: string }[] = [
  { key: "maxPerTx", label: "Per-tx" },
  { key: "dailyLimit", label: "Daily" },
  { key: "monthlyLimit", label: "Monthly" },
  { key: "velocityLimitPerMin", label: "Velocity/min" },
];

const badge = (src: string) => (
  <span
    className={
      "ml-1 rounded px-1 py-0.5 font-mono text-[9px] uppercase tracking-wider " +
      (src === "org"
        ? "bg-blue-500/15 text-blue-400"
        : src === "team"
          ? "bg-purple-500/15 text-purple-400"
          : "bg-accent/15 text-accent")
    }
  >
    {src}
  </span>
);

export default function DelegationPage() {
  const [tree, setTree] = useState<OrgNode[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ kind: "org" | "team"; id: string; name: string; policy: Record<string, number> } | null>(null);

  const refresh = useCallback(async () => {
    const data = await ownerApi<{ tree: OrgNode[] }>("/api/delegation");
    setTree(data.tree ?? []);
  }, []);

  useEffect(() => {
    refresh().catch(() => setMessage("could not load delegation tree"));
  }, [refresh]);

  async function save() {
    if (!editing) return;
    setMessage(null);
    try {
      await ownerApi("/api/delegation", {
        method: "POST",
        body: JSON.stringify(
          editing.kind === "org"
            ? { kind: "org", orgId: editing.id, policy: editing.policy }
            : { kind: "team", groupId: editing.id, policy: editing.policy },
        ),
      });
      setMessage(`${editing.kind} policy updated`);
      setEditing(null);
      await refresh();
    } catch {
      setMessage("failed to update policy");
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="font-mono text-xl font-bold tracking-tight">Delegation Tree</h1>
          <p className="text-sm text-muted">
            Org defaults are inherited by teams and wallets. Each level can only
            tighten policy — never loosen it. Badges show where every effective
            limit comes from.
          </p>
        </div>
        <Button variant="ghost" onClick={() => refresh()} className="gap-1.5">
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </Button>
      </header>

      {message && (
        <div className="rounded-md border border-border bg-panel/70 px-3 py-2 text-xs text-muted">
          {message}
        </div>
      )}

      {editing && (
        <div className="rounded-xl border border-accent/30 bg-panel/80 p-4 space-y-3">
          <h2 className="font-mono text-sm font-semibold uppercase tracking-widest text-accent">
            Edit {editing.kind} policy · {editing.name}
          </h2>
          <div className="grid md:grid-cols-4 gap-3">
            {FIELDS.map((f) => (
              <Field
                key={f.key}
                label={f.label}
                type="number"
                value={String(editing.policy[f.key] ?? 0)}
                onChange={(e) =>
                  setEditing((prev) =>
                    prev ? { ...prev, policy: { ...prev.policy, [f.key]: Number(e.target.value) } } : prev,
                  )
                }
              />
            ))}
          </div>
          <div className="flex gap-2">
            <Button onClick={save}>Save</Button>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {tree.map((org) => (
        <section key={org.id} className="rounded-xl border border-border bg-panel/70 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-mono text-sm font-semibold uppercase tracking-widest text-muted">
              <Network className="inline h-4 w-4 mr-1" />
              {org.name} · {org.id}
            </h2>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setEditing({
                  kind: "org",
                  id: org.id,
                  name: org.name,
                  policy: {
                    maxPerTx: org.policy?.maxPerTx ?? 100,
                    dailyLimit: org.policy?.dailyLimit ?? 1000,
                    monthlyLimit: org.policy?.monthlyLimit ?? 5000,
                    velocityLimitPerMin: org.policy?.velocityLimitPerMin ?? 30,
                  },
                })
              }
            >
              Set defaults
            </Button>
          </div>

          {org.teams.map((team) => (
            <div key={team.id} className="ml-4 border-l border-border pl-4 space-y-2">
              <div className="flex items-center justify-between">
                <div className="font-mono text-xs">
                  <span className="text-purple-400">team</span> {team.name} · monthly cap $
                  {team.monthlyLimit}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setEditing({
                      kind: "team",
                      id: team.id,
                      name: team.name,
                      policy: {
                        maxPerTx: team.policy?.maxPerTx ?? 100,
                        dailyLimit: team.policy?.dailyLimit ?? 1000,
                        monthlyLimit: team.policy?.monthlyLimit ?? 5000,
                        velocityLimitPerMin: team.policy?.velocityLimitPerMin ?? 30,
                      },
                    })
                  }
                >
                  Set policy
                </Button>
              </div>
              {team.wallets.map((w) => (
                <WalletRow key={w.id} wallet={w} />
              ))}
            </div>
          ))}

          {org.unassignedWallets.map((w) => <WalletRow key={w.id} wallet={w} />)}
        </section>
      ))}

      {tree.length === 0 && (
        <p className="text-sm text-muted">No organizations yet.</p>
      )}
    </div>
  );
}

function WalletRow({ wallet }: { wallet: WalletNode }) {
  const p = wallet.effective?.policy;
  if (!p) return null;
  return (
    <div className="ml-4 border-l border-border pl-4">
      <div className="rounded-lg border border-border bg-background/60 p-3">
        <div className="font-mono text-xs">
          <span className="text-accent">wallet</span> {wallet.name} · balance $
          {wallet.balance.toFixed(2)}
        </div>
        <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
          {FIELDS.map((f) => {
            const value = (p as unknown as Record<string, number>)[f.key];
            const isMoney = f.key !== "velocityLimitPerMin";
  const badge = (src: string) => (
    <span
      className={
        "ml-1 rounded px-1 py-0.5 font-mono text-[9px] uppercase tracking-wider " +
        (src === "org"
          ? "bg-blue-500/15 text-blue-400"
          : src === "team"
            ? "bg-purple-500/15 text-purple-400"
            : "bg-accent/15 text-accent")
      }
    >
      {src}
    </span>
  );

  return (
              <div key={f.key} className="flex items-center">
                <span className="text-muted mr-1">{f.label}:</span>
                <span className="font-mono">
                  {isMoney ? `$${value}` : value}
                  {badge(wallet.effective?.effectiveSources?.[f.key] ?? "wallet")}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
