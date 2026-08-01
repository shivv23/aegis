"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getSignerKeys,
  ownerApi,
  signerApi,
} from "@/lib/api-client";
import { Button, Card } from "@/components/ui";
import { shortId } from "@/lib/utils";
import { Users, KeyRound, Check, X, RefreshCw } from "lucide-react";

interface Signer {
  id: string;
  name: string;
  role: string;
  enabled: boolean;
  createdAt: number;
}

interface Approval {
  id: string;
  operation: string;
  walletId: string;
  label: string;
  proposer: string;
  required: number;
  approvers: string[];
  status: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";
  createdAt: number;
  expiresAt: number;
  keyMinted: boolean;
}

export default function MultiSigPage() {
  const [signers, setSigners] = useState<Signer[]>([]);
  const [signerCreds, setSignerCreds] = useState<Array<{ id: string; name: string; role: string; key: string }>>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [wallets, setWallets] = useState<string[]>([]);
  const [activeSigner, setActiveSigner] = useState<string>("");
  const [label, setLabel] = useState("ops-console");
  const [walletId, setWalletId] = useState("");
  const [minted, setMinted] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, a, w] = await Promise.all([
        ownerApi<{ signers: Signer[] }>("/api/signers"),
        ownerApi<{ approvals: Approval[] }>("/api/approvals"),
        ownerApi<{ wallets: Array<{ id: string }> }>("/api/wallet"),
      ]);
      setSigners(s.signers);
      setApprovals(a.approvals);
      const ids = w.wallets.map((x) => x.id);
      setWallets(ids);
      setWalletId((prev) => prev || ids[0] || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, []);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const [s, a, w] = await Promise.all([
          ownerApi<{ signers: Signer[] }>("/api/signers"),
          ownerApi<{ approvals: Approval[] }>("/api/approvals"),
          ownerApi<{ wallets: Array<{ id: string }> }>("/api/wallet"),
        ]);
        if (!alive) return;
        setSigners(s.signers);
        setApprovals(a.approvals);
        const ids = w.wallets.map((x) => x.id);
        setWallets(ids);
        setWalletId((prev) => prev || ids[0] || "");
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "Failed to load");
      }
    }
    async function loadKeys() {
      const keys = await getSignerKeys();
      if (!alive) return;
      setSignerCreds(keys);
      setActiveSigner(keys[0]?.key ?? "");
    }
    void load();
    void loadKeys();
    return () => {
      alive = false;
    };
  }, []);

  async function propose() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await ownerApi<{ approval: Approval }>("/api/approvals", {
        method: "POST",
        body: JSON.stringify({
          operation: "MINT_OWNER_KEY",
          walletId,
          label,
        }),
      });
      setNotice(
        `Proposal ${shortId(res.approval.id)} needs ${res.approval.required} signer(s).`,
      );
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Propose failed");
    } finally {
      setBusy(false);
    }
  }

  async function vote(id: string, approve: boolean) {
    setBusy(true);
    setError(null);
    setNotice(null);
    setMinted(null);
    try {
      const res = await signerApi<{
        approval: Approval;
        thresholdReached?: boolean;
        ownerKey?: string;
      }>(activeSigner, `/api/approvals/${id}/${approve ? "approve" : "reject"}`, {
        method: "POST",
      });
      if (res.ownerKey) {
        setMinted(res.ownerKey);
        setNotice("Threshold reached. Owner key minted.");
      } else {
        setNotice(
          approve
            ? `${res.approval.approvers.length}/${res.approval.required} approvals so far.`
            : "Request rejected.",
        );
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Vote failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-mono text-xl font-bold tracking-tight">Multi-sig Owners</h1>
        <p className="text-sm text-muted">
          Owner control-plane keys are issued 2-of-3. A stolen master key alone
          can&apos;t mint new authority.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <label className="text-xs font-mono text-muted uppercase tracking-widest">
          Acting as
        </label>
        <select
          className="rounded-md border border-border bg-panel px-3 py-2 font-mono text-sm"
          value={activeSigner}
          onChange={(e) => setActiveSigner(e.target.value)}
        >
          {signerCreds.map((s) => (
            <option key={s.id} value={s.key}>
              {s.name}
            </option>
          ))}
        </select>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </Button>
      </div>

      {error ? (
        <div className="rounded-md border border-danger/40 bg-danger/10 px-4 py-2 font-mono text-xs text-danger">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="rounded-md border border-accent/40 bg-accent/10 px-4 py-2 font-mono text-xs text-accent">
          {notice}
        </div>
      ) : null}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <Card className="p-5">
          <div className="mb-3 flex items-center gap-2 font-mono text-xs uppercase tracking-widest text-muted">
            <Users className="h-4 w-4" /> Signers ({signers.length}/3)
          </div>
          <div className="space-y-2">
            {signers.map((s) => (
              <div key={s.id} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                <div>
                  <div className="font-mono text-sm font-semibold">{s.name}</div>
                  <div className="font-mono text-[11px] text-muted">
                    {s.role} · {shortId(s.id)}
                  </div>
                </div>
                <span
                  className={`rounded px-2 py-0.5 font-mono text-[10px] ${
                    s.enabled ? "bg-accent/15 text-accent" : "bg-danger/15 text-danger"
                  }`}
                >
                  {s.enabled ? "ENABLED" : "OFF"}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-3 rounded-md border border-border bg-panel/60 px-3 py-2 text-[11px] leading-relaxed text-muted">
            Each signer holds an owner-scoped key. A key issuance is minted only
            after {approvals[0]?.required ?? 2} distinct signers approve.
          </div>
        </Card>

        <div className="xl:col-span-2">
          <Card className="p-5">
            <div className="mb-3 flex items-center gap-2 font-mono text-xs uppercase tracking-widest text-muted">
              <KeyRound className="h-4 w-4" /> Propose owner-key issuance
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <label className="block">
                <span className="text-[10px] font-mono uppercase tracking-widest text-muted">Wallet</span>
                <select
                  className="mt-1 w-full rounded-md border border-border bg-panel px-3 py-2 font-mono text-sm"
                  value={walletId}
                  onChange={(e) => setWalletId(e.target.value)}
                >
                  {wallets.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-[10px] font-mono uppercase tracking-widest text-muted">Key label</span>
                <input
                  className="mt-1 w-full rounded-md border border-border bg-panel px-3 py-2 font-mono text-sm"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </label>
              <div className="flex items-end">
                <Button onClick={() => void propose()} disabled={busy || !activeSigner}>
                  Propose
                </Button>
              </div>
            </div>

            <div className="mt-5 space-y-2">
              {approvals.length === 0 ? (
                <div className="rounded-md border border-border px-4 py-3 font-mono text-xs text-muted">
                  No approval requests yet. Propose an owner key to begin.
                </div>
              ) : (
                approvals.map((a) => (
                  <div key={a.id} className="rounded-md border border-border p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-mono text-sm font-semibold">
                          {a.operation} · {a.label}
                        </div>
                        <div className="font-mono text-[11px] text-muted">
                          {shortId(a.walletId)} · {a.approvers.length}/{a.required} approvals
                        </div>
                      </div>
                      <span
                        className={`rounded px-2 py-0.5 font-mono text-[10px] ${
                          a.status === "PENDING"
                            ? "bg-warn/15 text-warn"
                            : a.status === "APPROVED"
                              ? "bg-accent/15 text-accent"
                              : "bg-danger/15 text-danger"
                        }`}
                      >
                        {a.status}
                      </span>
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <div className="flex-1 h-1.5 overflow-hidden rounded-full bg-panel">
                        <div
                          className="h-full bg-accent"
                          style={{
                            width: `${Math.min(100, (a.approvers.length / a.required) * 100)}%`,
                          }}
                        />
                      </div>
                      {a.status === "PENDING" && activeSigner ? (
                        <>
                          <Button
                            size="sm"
                            disabled={busy || a.approvers.includes(activeSigner)}
                            onClick={() => void vote(a.id, true)}
                          >
                            <Check className="h-3.5 w-3.5" /> Approve
                          </Button>
                          <Button
                            variant="danger"
                            size="sm"
                            disabled={busy}
                            onClick={() => void vote(a.id, false)}
                          >
                            <X className="h-3.5 w-3.5" /> Reject
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </div>
                ))
              )}
            </div>
          </Card>
        </div>
      </div>

      {minted ? (
        <Card className="border-accent/40 bg-accent/5 p-5">
          <div className="mb-1 font-mono text-xs uppercase tracking-widest text-accent">
            Owner key minted — store it once
          </div>
          <div className="break-all rounded-md border border-border bg-panel p-3 font-mono text-[11px] text-foreground">
            {minted}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
