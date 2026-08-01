"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { ownerApi } from "@/lib/api-client";
import { clock, shortId } from "@/lib/utils";
import { FileText, RefreshCw, Receipt } from "lucide-react";
import type { Invoice, UsageRecord } from "@/core/types";

interface FeeRow {
  rail: string;
  bps: number;
  minUsd: number;
}

interface InvoicesData {
  invoices: Invoice[];
  fees: FeeRow[];
}

export default function BillingPage() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [fees, setFees] = useState<FeeRow[]>([]);
  const [usage, setUsage] = useState<UsageRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [inv, usg] = await Promise.all([
      ownerApi<InvoicesData>("/api/billing/invoices"),
      ownerApi<{ usage: UsageRecord[] }>("/api/usage"),
    ]);
    setInvoices(inv.invoices ?? []);
    setFees(inv.fees ?? []);
    setUsage(usg.usage ?? []);
  }, []);

  useEffect(() => {
    refresh().catch(() => setMessage("could not load billing data"));
  }, [refresh]);

  async function generate() {
    setBusy(true);
    setMessage(null);
    try {
      await ownerApi("/api/billing/invoices", { method: "POST", body: JSON.stringify({}) });
      setMessage("draft invoice generated from the last 30 days");
      await refresh();
    } catch {
      setMessage("no usage rows in the period yet");
    } finally {
      setBusy(false);
    }
  }

  async function finalize(invoiceId: string) {
    setBusy(true);
    setMessage(null);
    try {
      await ownerApi(`/api/billing/invoices/${invoiceId}/finalize`, { method: "POST" });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const feeLabel = (rail: string) => {
    const f = fees.find((x) => x.rail === rail);
    if (!f) return "free";
    return f.bps === 0 ? "free" : `${(f.bps / 100).toFixed(2)}%${f.minUsd ? ` (min $${f.minUsd.toFixed(2)})` : ""}`;
  };

  const totalFees = usage.reduce((acc, u) => acc + u.fee, 0);

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="font-mono text-xl font-bold tracking-tight">Billing & Usage</h1>
          <p className="text-sm text-muted">
            Usage rows are metered per settlement; invoices aggregate them into
            per-rail lines. Fees are configurable via <code className="font-mono">AEGIS_FEE_*</code>.
          </p>
        </div>
        <Button onClick={generate} disabled={busy} className="gap-2">
          <Receipt className="h-4 w-4" />
          Generate invoice
        </Button>
      </header>

      {message && (
        <div className="rounded-md border border-border bg-panel/70 px-3 py-2 text-xs text-muted">
          {message}
        </div>
      )}

      <section className="rounded-xl border border-border bg-panel/70 p-4 space-y-3">
        <h2 className="font-mono text-sm font-semibold uppercase tracking-widest text-muted">
          Fee schedule
        </h2>
        <div className="grid md:grid-cols-3 gap-3">
          {fees.map((f) => (
            <div key={f.rail} className="rounded-lg border border-border bg-background/60 p-3">
              <div className="font-mono text-xs text-accent">{f.rail}</div>
              <div className="mt-1 font-mono text-lg font-bold">{feeLabel(f.rail)}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-panel/70 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-mono text-sm font-semibold uppercase tracking-widest text-muted">
            Invoices
          </h2>
          <Button variant="ghost" onClick={() => refresh()} className="gap-1.5">
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
        </div>
        {invoices.length === 0 ? (
          <p className="text-sm text-muted">
            No invoices yet. Settle a few transactions then generate one.
          </p>
        ) : (
          <div className="space-y-3">
            {invoices.map((inv) => (
              <div key={inv.id} className="rounded-lg border border-border bg-background/60 p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 font-mono text-xs">
                    <FileText className="h-4 w-4 text-muted" />
                    INV-{shortId(inv.id)}
                    <span
                      className={
                        inv.status === "finalized"
                          ? "text-accent"
                          : "text-yellow-500"
                      }
                    >
                      {inv.status}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right font-mono text-xs text-muted">
                      <div>{clock(inv.periodStart)} — {clock(inv.periodEnd)}</div>
                      <div>fees ${inv.totalFeeUsd.toFixed(2)}</div>
                    </div>
                    {inv.status === "draft" && (
                      <Button variant="outline" size="sm" onClick={() => finalize(inv.id)} disabled={busy}>
                        Finalize
                      </Button>
                    )}
                  </div>
                </div>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left font-mono uppercase tracking-widest text-muted">
                      <th className="py-1 pr-3">Rail</th>
                      <th className="py-1 pr-3 text-right">Settled $</th>
                      <th className="py-1 text-right">Fee $</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inv.lines.map((l) => (
                      <tr key={l.rail} className="border-t border-border">
                        <td className="py-1 pr-3 font-mono">{l.rail}</td>
                        <td className="py-1 pr-3 text-right">${l.amountUsd.toFixed(2)}</td>
                        <td className="py-1 text-right">${l.feeUsd.toFixed(2)}</td>
                      </tr>
                    ))}
                    <tr className="border-t border-border font-mono">
                      <td className="py-1 pr-3 text-muted">total</td>
                      <td className="py-1 pr-3 text-right">${inv.totalUsd.toFixed(2)}</td>
                      <td className="py-1 text-right">${inv.totalFeeUsd.toFixed(2)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-border bg-panel/70 p-4 space-y-3">
        <h2 className="font-mono text-sm font-semibold uppercase tracking-widest text-muted">
          Recent usage · {totalFees.toFixed(2)} in fees
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left font-mono uppercase tracking-widest text-muted">
                <th className="py-1 pr-3">Time</th>
                <th className="py-1 pr-3">Rail</th>
                <th className="py-1 pr-3 text-right">Settled $</th>
                <th className="py-1 text-right">Fee $</th>
              </tr>
            </thead>
            <tbody>
              {usage.map((u) => (
                <tr key={u.id} className="border-t border-border">
                  <td className="py-1 pr-3 text-muted">{clock(u.createdAt)}</td>
                  <td className="py-1 pr-3 font-mono">{u.rail}</td>
                  <td className="py-1 pr-3 text-right">${u.amount.toFixed(2)}</td>
                  <td className="py-1 text-right">${u.fee.toFixed(2)}</td>
                </tr>
              ))}
              {usage.length === 0 && (
                <tr className="border-t border-border">
                  <td colSpan={4} className="py-2 text-muted">No usage recorded yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
