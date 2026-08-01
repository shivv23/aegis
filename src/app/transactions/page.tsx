"use client";

import { useMemo, useState } from "react";
import { useStream } from "@/hooks/use-stream";
import { Button, Reason, TxBadge } from "@/components/ui";
import { ownerApi } from "@/lib/api-client";
import { clock, money, shortId } from "@/lib/utils";
import { Check, PauseCircle, X } from "lucide-react";
import type { Transaction } from "@/core/types";

export default function TransactionsPage() {
  const { transactions } = useStream();
  const [filter, setFilter] = useState<string>("ALL");

  const filters = ["ALL", "PENDING", "STEP_UP_REQUIRED", "SETTLED", "BLOCKED", "REVOKED"];

  const rows = useMemo(() => {
    const txs = filter === "ALL" ? transactions : transactions.filter((t) => t.status === filter);
    return txs.slice(0, 100);
  }, [transactions, filter]);

  async function revoke(tx: Transaction) {
    await ownerApi(`/api/transactions/${tx.id}/revoke`, { method: "POST" });
  }

  async function stepUp(tx: Transaction, action: "approve" | "decline") {
    await ownerApi(`/api/transactions/${tx.id}/stepup`, {
      method: "POST",
      body: JSON.stringify({ action }),
    });
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-mono text-xl font-bold tracking-tight">Transactions</h1>
        <p className="text-sm text-muted">
          Every money movement passes through the guard. Nothing happens off-ledger.
        </p>
      </header>

      <div className="flex gap-2">
        {filters.map((f) => (
          <Button
            key={f}
            variant={filter === f ? "primary" : "outline"}
            size="sm"
            onClick={() => setFilter(f)}
          >
            {f}
          </Button>
        ))}
      </div>

      <div className="rounded-xl border border-border bg-panel/70 overflow-hidden">
        <div className="grid grid-cols-12 gap-2 px-4 py-2.5 border-b border-border font-mono text-[10px] uppercase tracking-widest text-muted">
          <span className="col-span-2">Time</span>
          <span className="col-span-2">Wallet</span>
          <span className="col-span-3">Movement</span>
          <span className="col-span-2">Purpose</span>
          <span className="col-span-1">Status</span>
          <span className="col-span-2 text-right">Verdict</span>
        </div>
        <div className="max-h-[600px] overflow-y-auto">
          {rows.length === 0 ? (
            <div className="px-4 py-12 text-center font-mono text-sm text-muted">
              no transactions{filter !== "ALL" ? ` with status ${filter}` : ""}
            </div>
          ) : (
            rows.map((tx) => (
              <div key={tx.id} className="grid grid-cols-12 gap-2 items-center px-4 py-2.5 border-b border-border/60 last:border-0 hover:bg-white/[0.03] font-mono text-xs">
                <span className="col-span-2 text-muted">{clock(tx.requestedAt)}</span>
                <span className="col-span-2 text-muted">{shortId(tx.walletId)}</span>
                <span className="col-span-3">
                  <span className="text-foreground">{money(tx.amount)}</span>
                  <span className="text-muted"> → </span>
                  <span className="text-info">{shortId(tx.to, 20)}</span>
                </span>
                <span className="col-span-2 text-muted truncate">{tx.purpose}</span>
                <span className="col-span-1"><TxBadge status={tx.status} /></span>
                <span className="col-span-2 flex items-center justify-end gap-2">
                  <Reason reason={tx.rejectionReason} />
                  {tx.status === "PENDING" ? (
                    <Button variant="warn" size="sm" onClick={() => revoke(tx)}>
                      <PauseCircle className="h-3.5 w-3.5" /> Revoke
                    </Button>
                  ) : null}
                  {tx.status === "STEP_UP_REQUIRED" ? (
                    <>
                      <Button variant="primary" size="sm" onClick={() => stepUp(tx, "approve")}>
                        <Check className="h-3.5 w-3.5" /> Approve
                      </Button>
                      <Button variant="danger" size="sm" onClick={() => stepUp(tx, "decline")}>
                        <X className="h-3.5 w-3.5" /> Decline
                      </Button>
                    </>
                  ) : null}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
