"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card, CodeBlock } from "@/components/ui";
import { listAgentKeys, ownerApi, revokeAgentKey } from "@/lib/api-client";
import { clock, shortId } from "@/lib/utils";
import { KeyRound, RefreshCw, ShieldOff, Check, Copy, AlertTriangle } from "lucide-react";

interface AgentKeyRow {
  publicKey: string;
  label: string;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
  acl?: { actions: string[] };
}

export function KeyLifecycle({ walletId }: { walletId: string }) {
  const [keys, setKeys] = useState<AgentKeyRow[]>([]);
  const [rotated, setRotated] = useState<{ publicKey: string; privateKey: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await listAgentKeys(walletId);
      setKeys(data.agentKeys);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [walletId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function rotate() {
    setError(null);
    try {
      const kp = await ownerApi<{ publicKey: string; privateKey: string }>(
        "/api/keys/rotate",
        { method: "POST", body: JSON.stringify({ walletId, oldPublicKey: keys[0]?.publicKey }) },
      );
      setRotated(kp);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function revoke(publicKey: string) {
    setError(null);
    try {
      await revokeAgentKey(walletId, publicKey);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied(null), 1500);
  }

  const active = keys.filter((k) => !k.revokedAt);
  const revoked = keys.filter((k) => k.revokedAt);

  return (
    <Card>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-info" />
          <span className="font-mono text-xs uppercase tracking-widest text-muted">
            Agent key lifecycle
          </span>
        </div>
        <Button variant="outline" size="sm" onClick={rotate} title="Revoke the current key and mint a fresh pair">
          <RefreshCw className="h-3.5 w-3.5" /> Rotate
        </Button>
      </div>

      {error ? (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
          <AlertTriangle className="h-3.5 w-3.5" /> {error}
        </div>
      ) : null}

      {active.length === 0 ? (
        <div className="py-3 text-sm text-muted">No active agent keys. Mint one below.</div>
      ) : (
        <div className="space-y-3">
          {active.map((k) => (
            <div key={k.publicKey} className="rounded-md border border-border bg-black/30 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs font-semibold text-accent">
                  {k.label} · {shortId(k.publicKey)}
                </span>
                <Button variant="danger" size="sm" onClick={() => revoke(k.publicKey)}>
                  <ShieldOff className="h-3.5 w-3.5" /> Revoke
                </Button>
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
                <span>minted {clock(k.createdAt)}</span>
                <span className={k.expiresAt && k.expiresAt < Date.now() ? "text-danger" : ""}>
                  {k.expiresAt ? `expires ${clock(k.expiresAt)}` : "never expires"}
                </span>
                <span>{k.lastUsedAt ? `last used ${clock(k.lastUsedAt)}` : "never used"}</span>
                <span>ACL: {(k.acl?.actions ?? []).join(", ") || "all"}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {revoked.length > 0 ? (
        <div className="mt-4">
          <div className="mb-2 text-[11px] font-mono uppercase tracking-widest text-muted">
            Revoked ({revoked.length})
          </div>
          <div className="space-y-1.5">
            {revoked.map((k) => (
              <div key={k.publicKey} className="font-mono text-[11px] text-muted line-through">
                {k.label} · {shortId(k.publicKey)} · revoked {clock(k.revokedAt!)}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {rotated ? (
        <div className="mt-4 rounded-md border border-accent/40 bg-accent/10 p-3">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="font-mono text-xs font-semibold text-accent">NEW PRIVATE KEY — save now</span>
            <button onClick={() => copy(rotated.privateKey)} className="flex items-center gap-1 text-[11px] font-mono text-info hover:underline">
              {copied === rotated.privateKey ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />} copy
            </button>
          </div>
          <CodeBlock text={rotated.privateKey} />
          <p className="mt-1 text-[11px] text-muted">
            The old key is revoked. This private key is shown once and cannot be recovered.
          </p>
        </div>
      ) : null}
    </Card>
  );
}
