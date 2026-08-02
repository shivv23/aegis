"use client";

import { useEffect, useState } from "react";
import { Button, Card } from "@/components/ui";
import { ownerApi } from "@/lib/api-client";
import { Check, ExternalLink, Link2, RefreshCw, X } from "lucide-react";

interface GuardianMirror {
  wallet: string | null;
  comparedWallet: { id: string | null; hash: string | null; isSealed: boolean };
  guardian: {
    address: string | null;
    registry: string | null;
    rpcUrl: string | null;
    chain: string;
    live: {
      paused: boolean | null;
      perTxCap: string | null;
      dailyLimit: string | null;
      velocityMax: string | null;
    };
  };
  policy: {
    hash: string | null;
    sealed: boolean;
    sealedWallet: string | null;
    onChain: string | null;
    matches: boolean | null;
    sealState: string;
    error: string | null;
    explanation: string;
  };
}

interface ResealResult {
  ok?: boolean;
  wallet?: string;
  policyHash?: string;
  command?: string;
  error?: string;
}

function shortAddr(a: string | null): string {
  if (!a) return "not deployed";
  return a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a;
}

export function GuardianPanel() {
  const [mirror, setMirror] = useState<GuardianMirror | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resealing, setResealing] = useState(false);
  const [resealMsg, setResealMsg] = useState<string | null>(null);

  async function load() {
    try {
      const m = await ownerApi<GuardianMirror>("/api/guardian");
      setMirror(m);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "guardian read failed");
    }
  }

  useEffect(() => {
    let active = true;
    ownerApi<GuardianMirror>("/api/guardian")
      .then((m) => {
        if (!active) return;
        setMirror(m);
        setError(null);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : "guardian read failed");
      });
    return () => {
      active = false;
    };
  }, []);

  async function reseal() {
    setResealing(true);
    setResealMsg(null);
    try {
      const res = await ownerApi<ResealResult>("/api/admin/reseal", { method: "POST" });
      if (res.ok) {
        setResealMsg(
          res.command
            ? `Target hash ${res.policyHash?.slice(0, 16)}… — run from contracts/: ${res.command}`
            : "Seal state updated.",
        );
      } else {
        setResealMsg(res.error ?? "Re-seal unavailable.");
      }
      await load();
    } catch (e) {
      setResealMsg(e instanceof Error ? e.message : "Re-seal request failed.");
    } finally {
      setResealing(false);
    }
  }

  if (error) {
    return (
      <Card>
        <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 font-mono text-xs text-warn">
          {error}
        </div>
      </Card>
    );
  }

  if (!mirror) {
    return (
      <Card>
        <div className="font-mono text-xs text-muted">reading live chain state…</div>
      </Card>
    );
  }

  const live = mirror.guardian.live;

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Link2 className="h-4 w-4 text-accent" />
          <span className="font-mono text-xs uppercase tracking-widest text-muted">
            On-chain guardian · {mirror.guardian.chain}
          </span>
        </div>
        <a
          href={mirror.guardian.address ? `https://sepolia.etherscan.io/address/${mirror.guardian.address}` : undefined}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 text-[11px] font-mono text-info hover:underline"
        >
          {mirror.guardian.address ? "explorer" : null}
          {mirror.guardian.address ? <ExternalLink className="h-3 w-3" /> : null}
        </a>
      </div>

      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
          <div className="text-muted">Guardian</div>
          <div className="text-right text-foreground">{shortAddr(mirror.guardian.address)}</div>
          <div className="text-muted">Policy registry</div>
          <div className="text-right text-foreground">{shortAddr(mirror.guardian.registry)}</div>
          <div className="text-muted">Paused (live)</div>
          <div className="text-right">
            {live.paused === null ? (
              <span className="text-muted">unreachable</span>
            ) : live.paused ? (
              <span className="text-danger">true</span>
            ) : (
              <span className="text-emerald-400">false</span>
            )}
          </div>
          <div className="text-muted">Per-tx cap (live)</div>
          <div className="text-right text-foreground">
            {live.perTxCap ? `$${BigInt(live.perTxCap) / 10n ** 18n}` : "—"}
          </div>
          <div className="text-muted">Daily limit (live)</div>
          <div className="text-right text-foreground">
            {live.dailyLimit ? `$${BigInt(live.dailyLimit) / 10n ** 18n}` : "—"}
          </div>
        </div>

        <div className="border-t border-border/60 pt-3 space-y-2">
          <div className="flex items-center gap-2 font-mono text-[11px]">
            <span className="text-muted">Policy seal</span>
            {mirror.policy.sealState === "verified" ? (
              <span className="flex items-center gap-1 text-emerald-400">
                <Check className="h-3.5 w-3.5" /> verified on-chain
              </span>
            ) : mirror.policy.sealState === "mismatch" ? (
              <span className="flex items-center gap-1 text-warn">
                <X className="h-3.5 w-3.5" /> policy changed since seal
              </span>
            ) : (
              <span className="flex items-center gap-1 text-muted">
                <X className="h-3.5 w-3.5" /> not verified
              </span>
            )}
          </div>
          <div className="font-mono text-[10px] text-muted break-all">
            app {mirror.policy.hash ?? "—"}
          </div>
          <div className="font-mono text-[10px] text-muted break-all">
            chain {mirror.policy.onChain ?? "—"}
          </div>
          {mirror.policy.sealedWallet ? (
            <div className="font-mono text-[10px] text-emerald-400">
              sealed wallet {mirror.policy.sealedWallet}
            </div>
          ) : null}
          <p className="text-[11px] leading-relaxed text-muted">
            {mirror.policy.explanation}
          </p>
          {mirror.policy.sealState === "mismatch" ? (
            <div className="space-y-2">
              <Button variant="warn" size="sm" onClick={reseal} disabled={resealing}>
                <RefreshCw className={`h-3.5 w-3.5 ${resealing ? "animate-spin" : ""}`} />
                Re-seal on-chain
              </Button>
              {resealMsg ? (
                <div className="font-mono text-[10px] text-warn break-all">{resealMsg}</div>
              ) : null}
            </div>
          ) : null}
          {mirror.policy.error ? (
            <div className="font-mono text-[10px] text-warn break-all">
              {mirror.policy.error}
            </div>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
