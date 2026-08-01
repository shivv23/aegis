"use client";

import { useEffect, useMemo, useState } from "react";
import { use } from "react";
import { useStream } from "@/hooks/use-stream";
import {
  Button,
  Card,
  CodeBlock,
  Field,
  Money,
  WalletBadge,
} from "@/components/ui";
import { LiveFeed } from "@/components/live-feed";
import { SimulatorConsole } from "@/components/simulator-console";
import { KeyLifecycle } from "@/components/key-lifecycle";
import { mintKeys, ownerApi } from "@/lib/api-client";
import { clock, shortId } from "@/lib/utils";
import {
  Snowflake,
  Zap,
  KeyRound,
  ShieldCheck,
  Copy,
  Check,
  PauseCircle,
  X,
} from "lucide-react";
import type { AuditLogEntry, Transaction } from "@/core/types";

export default function WalletDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { wallets, transactions, audit } = useStream();

  const wallet = useMemo(
    () => wallets.find((w) => w.id === id) ?? null,
    [wallets, id],
  );

  const walletTxs = useMemo(
    () => transactions.filter((t) => t.walletId === id),
    [transactions, id],
  );

  const walletAudit = useMemo(
    () => audit.filter((a) => a.walletId === id),
    [audit, id],
  );

  const [keys, setKeys] = useState<{ agentKey: string; ownerKey: string } | null>(null);
  const [keypair, setKeypair] = useState<{
    publicKey: string;
    privateKey: string;
    label: string;
  } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const [maxPerTx, setMaxPerTx] = useState("");
  const [dailyLimit, setDailyLimit] = useState("");
  const [monthlyLimit, setMonthlyLimit] = useState("");
  const [velocity, setVelocity] = useState("");
  const [allowlist, setAllowlist] = useState("");
  const [newAddr, setNewAddr] = useState("");

  useEffect(() => {
    if (wallet && !editing) {
      setMaxPerTx(String(wallet.policy.maxPerTx));
      setDailyLimit(String(wallet.policy.dailyLimit));
      setMonthlyLimit(String(wallet.policy.monthlyLimit));
      setVelocity(String(wallet.policy.velocityLimitPerMin));
      setAllowlist(wallet.policy.allowlist.join(", "));
    }
  }, [wallet, editing]);

  async function freeze(freeze: boolean) {
    await ownerApi(`/api/wallet/${id}/${freeze ? "freeze" : "unfreeze"}`, {
      method: "POST",
    });
  }

  async function savePolicy() {
    await ownerApi(`/api/wallet/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        maxPerTx: Number(maxPerTx),
        dailyLimit: Number(dailyLimit),
        monthlyLimit: Number(monthlyLimit),
        velocityLimitPerMin: Number(velocity),
        allowlist: allowlist
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      }),
    });
    setEditing(false);
  }

  async function addAllowlist() {
    if (!newAddr.trim()) return;
    const next = [...new Set([...allowlist.split(",").map((s) => s.trim()).filter(Boolean), newAddr.trim()])];
    setAllowlist(next.join(", "));
    setNewAddr("");
  }

  async function mint() {
    const k = await mintKeys(id);
    setKeys({ agentKey: k.agentKey, ownerKey: k.walletOwnerKey });
  }

  async function mintKeypair() {
    const kp = await ownerApi<{
      publicKey: string;
      privateKey: string;
      label: string;
    }>("/api/keys/mint", {
      method: "POST",
      body: JSON.stringify({ walletId: id, label: "agent-" + Date.now().toString(36) }),
    });
    setKeypair(kp);
  }

  async function revoke(tx: Transaction) {
    await ownerApi(`/api/transactions/${tx.id}/revoke`, { method: "POST" });
  }

  async function stepUp(tx: Transaction, action: "approve" | "decline") {
    await ownerApi(`/api/transactions/${tx.id}/stepup`, {
      method: "POST",
      body: JSON.stringify({ action }),
    });
  }

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied(null), 1500);
  }

  if (!wallet) {
    return (
      <div className="space-y-6">
        <h1 className="font-mono text-xl font-bold">Wallet</h1>
        <Card>
          <div className="font-mono text-sm text-muted">
            Loading wallet <span className="text-info">{shortId(id)}</span>…
          </div>
        </Card>
      </div>
    );
  }

  const frozen = wallet.status === "FROZEN";
  const pending = walletTxs.filter((t) => t.status === "PENDING");
  const awaitingApproval = walletTxs.filter((t) => t.status === "STEP_UP_REQUIRED");

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-mono text-xl font-bold tracking-tight">
              {wallet.name}
            </h1>
            <WalletBadge status={wallet.status} />
          </div>
          <p className="mt-1 font-mono text-xs text-muted">
            {wallet.id} · owner {wallet.ownerDid}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {pending.length > 0 ? (
            <div className="font-mono text-[11px] text-warn">
              {pending.length} in-flight transaction{pending.length > 1 ? "s" : ""}
            </div>
          ) : null}
          {frozen ? (
            <Button variant="warn" onClick={() => freeze(false)}>
              <Zap className="h-4 w-4" /> Release kill switch
            </Button>
          ) : (
            <Button variant="danger" onClick={() => freeze(true)} className="freeze-pulse">
              <Snowflake className="h-4 w-4" /> ENGAGE KILL SWITCH
            </Button>
          )}
        </div>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="flex flex-col gap-1">
          <div className="text-[11px] font-mono uppercase tracking-widest text-muted">Balance</div>
          <div className="font-mono text-2xl font-bold"><Money value={wallet.balance} /></div>
        </Card>
        <Card className="flex flex-col gap-1">
          <div className="text-[11px] font-mono uppercase tracking-widest text-muted">Daily limit</div>
          <div className="font-mono text-2xl font-bold"><Money value={wallet.policy.dailyLimit} /></div>
        </Card>
        <Card className="flex flex-col gap-1">
          <div className="text-[11px] font-mono uppercase tracking-widest text-muted">Allowlist</div>
          <div className="font-mono text-2xl font-bold">{wallet.policy.allowlist.length}</div>
          <div className="text-[11px] text-muted">approved counterparties</div>
        </Card>
        <Card className="flex flex-col gap-1">
          <div className="text-[11px] font-mono uppercase tracking-widest text-muted">Velocity</div>
          <div className="font-mono text-2xl font-bold">{wallet.policy.velocityLimitPerMin}</div>
          <div className="text-[11px] text-muted">tx / minute max</div>
        </Card>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className="space-y-6">
          <Card>
            <div className="flex items-center justify-between mb-4">
              <div className="font-mono text-xs uppercase tracking-widest text-muted">
                Enforcement policy
              </div>
              <Button variant="outline" size="sm" onClick={() => (editing ? savePolicy() : setEditing(true))}>
                {editing ? "Save policy" : "Edit policy"}
              </Button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Max per tx ($)" type="number" value={maxPerTx} readOnly={!editing} onChange={(e) => setMaxPerTx(e.target.value)} />
              <Field label="Daily limit ($)" type="number" value={dailyLimit} readOnly={!editing} onChange={(e) => setDailyLimit(e.target.value)} />
              <Field label="Monthly limit ($)" type="number" value={monthlyLimit} readOnly={!editing} onChange={(e) => setMonthlyLimit(e.target.value)} />
              <Field label="Velocity (tx/min)" type="number" value={velocity} readOnly={!editing} onChange={(e) => setVelocity(e.target.value)} />
            </div>

            <div className="mt-4">
              <div className="mb-2 text-[11px] font-mono uppercase tracking-widest text-muted">
                Allowlisted counterparties
              </div>
              {editing ? (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <Field label="" placeholder="add:0x1234…" value={newAddr} onChange={(e) => setNewAddr(e.target.value)} className="flex-1" />
                    <Button variant="outline" size="sm" onClick={addAllowlist}>Add</Button>
                  </div>
                  <textarea
                    value={allowlist}
                    onChange={(e) => setAllowlist(e.target.value)}
                    rows={3}
                    className="w-full rounded-md border border-border bg-black/40 px-3 py-2 text-sm font-mono text-foreground outline-none focus:border-accent/60"
                  />
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {wallet.policy.allowlist.map((a) => (
                    <span key={a} className="rounded border border-accent/30 bg-accent/10 px-2 py-1 font-mono text-[11px] text-accent">
                      {a}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </Card>

          <Card>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-info" />
                <span className="font-mono text-xs uppercase tracking-widest text-muted">
                  Scoped keys
                </span>
              </div>
              <Button variant="outline" size="sm" onClick={mint}>
                {keys ? "Re-mint" : "Mint keys"}
              </Button>
            </div>
            {keys ? (
              <div className="space-y-3">
                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-[11px] font-mono text-danger">AGENT KEY</span>
                    <button onClick={() => copy(keys.agentKey)} className="flex items-center gap-1 text-[11px] font-mono text-info hover:underline">
                      {copied === keys.agentKey ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />} copy
                    </button>
                  </div>
                  <CodeBlock text={keys.agentKey} />
                  <p className="mt-1 text-[11px] text-muted">
                    The only credential an agent holds. Can call the rail — nothing else.
                  </p>
                </div>
                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-[11px] font-mono text-accent">OWNER KEY</span>
                    <button onClick={() => copy(keys.ownerKey)} className="flex items-center gap-1 text-[11px] font-mono text-accent hover:underline">
                      {copied === keys.ownerKey ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />} copy
                    </button>
                  </div>
                  <CodeBlock text={keys.ownerKey} />
                  <p className="mt-1 text-[11px] text-muted">
                    Controls policy, the kill switch, and in-flight revocation.
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 rounded-md border border-border bg-black/30 px-3 py-3">
                <ShieldCheck className="h-4 w-4 text-muted" />
                <span className="font-mono text-xs text-muted">
                  Mint to receive the agent key for the simulator and the owner key.
                </span>
              </div>
            )}

            <div className="mt-4 border-t border-border/60 pt-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-[11px] font-mono uppercase tracking-widest text-muted">
                  Agent keypair (Ed25519)
                </span>
                <Button variant="outline" size="sm" onClick={mintKeypair}>
                  {keypair ? "Re-mint keypair" : "Mint keypair"}
                </Button>
              </div>
              {keypair ? (
                <div className="space-y-3">
                  <div>
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-[11px] font-mono text-info">AGENT PRIVATE KEY (secret)</span>
                      <button onClick={() => copy(keypair.privateKey)} className="flex items-center gap-1 text-[11px] font-mono text-info hover:underline">
                        {copied === keypair.privateKey ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />} copy
                      </button>
                    </div>
                    <CodeBlock text={keypair.privateKey} />
                    <p className="mt-1 text-[11px] text-warn">
                      Shown once. The agent signs every transfer with it — a stolen token is useless without this key.
                    </p>
                  </div>
                  <div>
                    <div className="mb-1.5 text-[11px] font-mono text-muted">PUBLIC KEY (stored)</div>
                    <CodeBlock text={keypair.publicKey} />
                    <p className="mt-1 text-[11px] text-muted">
                      Set AGENT_PRIVATE_KEY and run{" "}
                      <code className="text-accent">npm run sim</code> to attack the rail with a signed identity.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="text-[11px] text-muted">
                  Sign-verified agent identity. The rail accepts
                  Ed25519-signed transfers in <code className="text-accent">x-aegis-*</code> headers.
                </div>
              )}
            </div>
          </Card>

          <KeyLifecycle walletId={wallet.id} />
        </div>

        <div className="space-y-6">
          <SimulatorConsole walletId={wallet.id} agentKey={keys?.agentKey ?? null} frozen={frozen} />

          {awaitingApproval.length > 0 ? (
            <Card className="border-orange-400/40">
              <div className="mb-3 font-mono text-xs uppercase tracking-widest text-orange-300">
                Awaiting owner approval — risk engine flagged high risk
              </div>
              <div className="space-y-2">
                {awaitingApproval.map((tx) => (
                  <div key={tx.id} className="flex items-center justify-between gap-3 rounded-md border border-border bg-black/30 px-3 py-2">
                    <div className="min-w-0">
                      <div className="font-mono text-sm">
                        <Money value={tx.amount} /> → {shortId(tx.to, 18)}
                        {tx.stepUpScore != null ? (
                          <span className="ml-2 text-[11px] text-orange-300">
                            risk {tx.stepUpScore}/100
                          </span>
                        ) : null}
                      </div>
                      <div className="text-[11px] text-muted">{tx.purpose}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button variant="primary" size="sm" onClick={() => stepUp(tx, "approve")}>
                        <Check className="h-3.5 w-3.5" /> Approve
                      </Button>
                      <Button variant="danger" size="sm" onClick={() => stepUp(tx, "decline")}>
                        <X className="h-3.5 w-3.5" /> Decline
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}

          {pending.length > 0 ? (
            <Card className="border-warn/40">
              <div className="mb-3 font-mono text-xs uppercase tracking-widest text-warn">
                In-flight — revoke before settlement
              </div>
              <div className="space-y-2">
                {pending.map((tx) => (
                  <div key={tx.id} className="flex items-center justify-between gap-3 rounded-md border border-border bg-black/30 px-3 py-2">
                    <div className="min-w-0">
                      <div className="font-mono text-sm">
                        <Money value={tx.amount} /> → {shortId(tx.to, 18)}
                      </div>
                      <div className="text-[11px] text-muted">{tx.purpose}</div>
                    </div>
                    <Button variant="warn" size="sm" onClick={() => revoke(tx)}>
                      <PauseCircle className="h-3.5 w-3.5" /> Revoke
                    </Button>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div>
          <div className="mb-2 font-mono text-xs uppercase tracking-widest text-muted">
            Transactions
          </div>
          <LiveFeed transactions={walletTxs} />
        </div>
        <div>
          <div className="mb-2 font-mono text-xs uppercase tracking-widest text-muted">
            Audit trail
          </div>
          <AuditFeed entries={walletAudit} />
        </div>
      </div>
    </div>
  );
}

function AuditFeed({ entries }: { entries: AuditLogEntry[] }) {
  return (
    <div className="rounded-xl border border-border bg-panel/70 overflow-hidden max-h-[480px] overflow-y-auto">
      {entries.length === 0 ? (
        <div className="px-4 py-10 text-center font-mono text-sm text-muted">
          no audit entries
        </div>
      ) : (
        entries.map((e) => (
          <div key={e.id} className="flex items-start gap-3 px-4 py-2.5 border-b border-border/60 last:border-0 font-mono text-[11px] leading-relaxed">
            <span className="text-muted w-16 shrink-0">{clock(e.timestamp)}</span>
            <span
              className={`w-32 shrink-0 font-bold ${
                e.actor === "owner" ? "text-accent" : e.actor === "agent" ? "text-info" : "text-muted"
              }`}
            >
              {e.actor.toUpperCase()}
            </span>
            <span className="w-40 shrink-0 text-warn">{e.action}</span>
            <span className="text-foreground">{e.details}</span>
          </div>
        ))
      )}
    </div>
  );
}
