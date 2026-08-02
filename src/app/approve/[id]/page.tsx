"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Button, Card, Money, TxBadge } from "@/components/ui";
import { shortId } from "@/lib/utils";
import { Check, ShieldAlert, X, Loader2, Fingerprint } from "lucide-react";
import type { Transaction } from "@/core/types";

/**
 * /approve/[id]?token=… — the one-tap destination of email/Slack approval
 * links. The token is a short-lived `aegis-decision` JWT; this page performs
 * the approve/decline without ever asking the owner for a key.
 */
export default function ApprovePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const search = useSearchParams();
  const token = search.get("token");

  const [tx, setTx] = useState<Transaction | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ ok: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [passkeyBusy, setPasskeyBusy] = useState(false);

  useEffect(() => {
    let active = true;
    if (!token) {
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const res = await fetch(`/api/transactions/${id}/stepup/link?token=${encodeURIComponent(token)}`);
        const data = await res.json().catch(() => ({}));
        if (!active) return;
        if (res.ok) {
          setTx((data as { transaction?: Transaction }).transaction ?? null);
          setError(null);
        } else {
          setTx(null);
          setError((data as { error?: string }).error ?? "Could not load the transaction.");
        }
      } catch {
        if (active) setError("Could not load the transaction.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [id, token]);

  async function decide(action: "approve" | "decline") {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/transactions/${id}/stepup/link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDone({ ok: false, message: (data as { error?: string }).error ?? "Decision failed." });
      } else {
        setDone({ ok: true, message: (data as { message?: string }).message ?? "Decision recorded." });
        setTx((data as { transaction?: Transaction }).transaction ?? tx);
      }
    } catch {
      setDone({ ok: false, message: "Network error. Please try again." });
    } finally {
      setBusy(false);
    }
  }

  async function approveWithPasskey() {
    setPasskeyBusy(true);
    setError(null);
    try {
      const begin = await fetch("/api/passkey/assert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txId: id }),
      });
      const beginData = await begin.json().catch(() => ({}));
      if (!begin.ok) {
        setDone({
          ok: false,
          message:
            (beginData as { error?: string }).error ??
            "No owner key in this browser — use the Approve/Decline buttons instead.",
        });
        return;
      }
      const cred = await (navigator as any).credentials?.get({
        publicKey: (beginData as { options?: unknown }).options,
      });
      if (!cred) {
        setDone({ ok: false, message: "Passkey assertion cancelled." });
        return;
      }
      const res = await fetch("/api/passkey/assert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txId: id, credential: cred }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDone({ ok: false, message: (data as { error?: string }).error ?? "Passkey approval failed." });
      } else {
        setDone({ ok: true, message: (data as { message?: string }).message ?? "Approved with hardware key." });
        setTx((data as { transaction?: Transaction }).transaction ?? tx);
      }
    } catch {
      setDone({
        ok: false,
        message: (navigator as any).credentials
          ? "Passkey approval failed."
          : "This browser doesn't support WebAuthn.",
      });
    } finally {
      setPasskeyBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg px-6 py-14">
      <Card className="p-8">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg border border-orange-400/40 bg-orange-400/10">
            <ShieldAlert className="h-6 w-6 text-orange-300" />
          </div>
          <div>
            <div className="font-mono text-lg font-bold tracking-tight">
              Owner decision required
            </div>
            <div className="font-mono text-xs text-muted">
              High-risk transfer · one-tap approve or decline
            </div>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 font-mono text-sm text-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : error && !tx ? (
          <div className="font-mono text-sm text-danger">{error}</div>
        ) : !token ? (
          <div className="font-mono text-sm text-danger">
            Missing or expired decision link (no token).
          </div>
        ) : done ? (
          <div
            className={`rounded-md border p-4 font-mono text-sm ${
              done.ok
                ? "border-accent/40 bg-accent/10 text-accent"
                : "border-danger/40 bg-danger/10 text-danger"
            }`}
          >
            {done.message}
            <div className="mt-4">
              <Link href="/" className="text-info underline">
                Back to Command Center
              </Link>
            </div>
          </div>
        ) : (
          <>
            <div className="mb-6 space-y-3">
              <div className="flex items-center justify-between rounded-md border border-border bg-black/30 px-4 py-3">
                <span className="font-mono text-xs uppercase tracking-widest text-muted">
                  Amount
                </span>
                <span className="font-mono text-xl font-bold">
                  {tx ? <Money value={tx.amount} /> : "—"}
                </span>
              </div>
              <div className="flex items-center justify-between rounded-md border border-border bg-black/30 px-4 py-3">
                <span className="font-mono text-xs uppercase tracking-widest text-muted">
                  Payee
                </span>
                <span className="font-mono text-sm text-info">
                  {tx ? shortId(tx.to, 24) : "—"}
                </span>
              </div>
              {tx?.purpose ? (
                <div className="flex items-center justify-between rounded-md border border-border bg-black/30 px-4 py-3">
                  <span className="font-mono text-xs uppercase tracking-widest text-muted">
                    Purpose
                  </span>
                  <span className="font-mono text-sm">{tx.purpose}</span>
                </div>
              ) : null}
              {tx?.stepUpScore != null ? (
                <div className="flex items-center justify-between rounded-md border border-border bg-black/30 px-4 py-3">
                  <span className="font-mono text-xs uppercase tracking-widest text-muted">
                    Risk score
                  </span>
                  <span className="font-mono text-sm text-orange-300">
                    {tx.stepUpScore}/100
                  </span>
                </div>
              ) : null}
              {tx ? (
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs text-muted">Status</span>
                  <TxBadge status={tx.status} />
                </div>
              ) : null}
            </div>

            <div className="flex gap-3">
              <Button variant="primary" className="flex-1 py-3" onClick={() => decide("approve")} disabled={busy}>
                <Check className="h-4 w-4" /> Approve
              </Button>
              <Button variant="danger" className="flex-1 py-3" onClick={() => decide("decline")} disabled={busy}>
                <X className="h-4 w-4" /> Decline
              </Button>
            </div>
            <div className="mt-3">
              <Button
                variant="outline"
                className="w-full py-2.5"
                onClick={() => void approveWithPasskey()}
                disabled={passkeyBusy}
              >
                {passkeyBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Fingerprint className="h-4 w-4" />}
                Approve with hardware key
              </Button>
            </div>
            <p className="mt-4 text-center text-[11px] text-muted">
              This link expires shortly. The transaction settles after the holding
              window if approved.
            </p>
          </>
        )}
      </Card>
    </div>
  );
}
