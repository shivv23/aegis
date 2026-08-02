"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useStream } from "@/hooks/use-stream";
import { Button, Card, Field, WalletBadge } from "@/components/ui";
import { createWallet } from "@/lib/api-client";
import { money, shortId } from "@/lib/utils";
import { Plus, Copy, Check } from "lucide-react";

export default function WalletRegistry() {
  const { wallets } = useStream();
  const router = useRouter();

  const [name, setName] = useState("ArbBot-7");
  const [ownerDid, setOwnerDid] = useState("did:org:quantum");
  const [balance, setBalance] = useState("5000");
  const [maxPerTx, setMaxPerTx] = useState("50");
  const [dailyLimit, setDailyLimit] = useState("500");
  const [monthlyLimit, setMonthlyLimit] = useState("2500");
  const [velocity, setVelocity] = useState("20");
  const [allowlist, setAllowlist] = useState(
    "compute:0xCAFE0001, api:0xBEEF0002",
  );
  const [created, setCreated] = useState<{
    wallet: { id: string; name: string };
    agentKey: string;
    ownerKey: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await createWallet({
        name,
        ownerDid,
        balance: Number(balance),
        maxPerTx: Number(maxPerTx),
        dailyLimit: Number(dailyLimit),
        monthlyLimit: Number(monthlyLimit),
        velocityLimitPerMin: Number(velocity),
        allowlist: allowlist
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      });
      setCreated(res);
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied(null), 1500);
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-mono text-xl font-bold tracking-tight">
          Wallet Registry
        </h1>
        <p className="text-sm text-muted">
          Provision wallets and define the policy an agent can never exceed.
        </p>
      </header>

      <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">
        <Card className="xl:col-span-2">
          <div className="mb-4 font-mono text-xs uppercase tracking-widest text-muted">
            Provision wallet
          </div>
          <form onSubmit={handleCreate} id="provision-form" className="space-y-3">
            <Field label="Agent name" value={name} onChange={(e) => setName(e.target.value)} required />
            <Field label="Owner DID" value={ownerDid} onChange={(e) => setOwnerDid(e.target.value)} required />
            <Field
              label="Starting balance ($)"
              type="number"
              value={balance}
              onChange={(e) => setBalance(e.target.value)}
              required
            />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Max per tx ($)" type="number" value={maxPerTx} onChange={(e) => setMaxPerTx(e.target.value)} required />
              <Field label="Daily limit ($)" type="number" value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} required />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Monthly limit ($)" type="number" value={monthlyLimit} onChange={(e) => setMonthlyLimit(e.target.value)} required />
              <Field label="Velocity (tx/min)" type="number" value={velocity} onChange={(e) => setVelocity(e.target.value)} required />
            </div>
            <Field
              label="Allowlist (comma-separated)"
              value={allowlist}
              onChange={(e) => setAllowlist(e.target.value)}
              hint="Only these counterparties can be paid, ever."
            />
            <Button type="submit" disabled={busy} className="w-full">
              <Plus className="h-4 w-4" /> {busy ? "Provisioning…" : "Provision Wallet"}
            </Button>
          </form>

          {created ? (
            <div className="mt-4 space-y-3 rounded-md border border-accent/40 bg-accent/5 p-4">
              <div className="font-mono text-xs text-accent">
                Wallet <span className="font-bold">{created.wallet.name}</span> provisioned. These keys are shown once.
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <button onClick={() => copy(created.agentKey)} className="flex items-center gap-1.5 text-[11px] font-mono text-info hover:underline">
                    {copied === created.agentKey ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />} copy
                  </button>
                  <code className="flex-1 truncate rounded border border-border bg-black/40 px-2 py-1 text-[10px] font-mono text-info">
                    {created.agentKey}
                  </code>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => copy(created.ownerKey)} className="flex items-center gap-1.5 text-[11px] font-mono text-accent hover:underline">
                    {copied === created.ownerKey ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />} copy
                  </button>
                  <code className="flex-1 truncate rounded border border-border bg-black/40 px-2 py-1 text-[10px] font-mono text-accent">
                    {created.ownerKey}
                  </code>
                </div>
                <div className="font-mono text-[10px] text-muted">
                  agentKey → /api/rail/transfer only. ownerKey → policy, freeze, revoke.
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => router.push(`/wallet/${created.wallet.id}`)}
              >
                Open wallet →
              </Button>
            </div>
          ) : null}
        </Card>

        <div className="xl:col-span-3 space-y-3">
          <div className="font-mono text-xs uppercase tracking-widest text-muted">
            {wallets.length} provisioned
          </div>
          {wallets.length === 0 ? (
            <div className="space-y-3 rounded-xl border border-dashed border-border bg-panel/40 px-6 py-10 text-center">
              <div className="font-mono text-sm font-semibold text-foreground">
                No wallets yet — bring an agent on-chain
              </div>
              <p className="mx-auto max-w-md font-mono text-xs leading-relaxed text-muted">
                Fill in the <span className="text-accent">Provision wallet</span> form
                on the left to mint a policy-locked wallet and its keys. Each wallet
                carries a spending policy an agent can never exceed, and a live
                guardian signature that seals that policy on-chain.
              </p>
              <button
                onClick={() => document.getElementById("provision-form")?.scrollIntoView({ behavior: "smooth", block: "center" })}
                className="rounded-lg border border-accent/40 px-3 py-2 font-mono text-xs font-semibold text-accent hover:bg-accent/10"
              >
                Provision your first wallet →
              </button>
            </div>
          ) : (
            wallets.map((w) => (
              <Card key={w.id} className="flex items-center justify-between gap-4">
                <button
                  className="text-left"
                  onClick={() => router.push(`/wallet/${w.id}`)}
                >
                  <div className="font-mono text-sm font-semibold hover:text-accent">
                    {w.name}
                  </div>
                  <div className="font-mono text-[11px] text-muted">
                    {shortId(w.id)} · {w.ownerDid}
                  </div>
                </button>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <div className="font-mono text-sm font-bold">{money(w.balance)}</div>
                    <div className="text-[10px] font-mono uppercase text-muted">balance</div>
                  </div>
                  <WalletBadge status={w.status} />
                  <Button variant="outline" size="sm" onClick={() => router.push(`/wallet/${w.id}`)}>
                    Manage
                  </Button>
                </div>
              </Card>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
