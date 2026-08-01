"use client";

import { useMemo, useState } from "react";
import { useStream } from "@/hooks/use-stream";
import { Button, Reason, TxBadge } from "@/components/ui";
import { ownerApi } from "@/lib/api-client";
import { clock, money, shortId } from "@/lib/utils";
import { Check, ChevronLeft, ChevronRight, PauseCircle, Search, X } from "lucide-react";
import type { Transaction } from "@/core/types";

const PAGE_SIZE = 10;

export default function TransactionsPage() {
  const { transactions } = useStream();
  const [filter, setFilter] = useState<string>("ALL");
  const [query, setQuery] = useState<string>("");
  const [page, setPage] = useState<number>(0);

  const filters = ["ALL", "PENDING", "STEP_UP_REQUIRED", "SETTLED", "BLOCKED", "REVOKED"];

  const pages = useMemo(() => {
    const q = query.trim().toLowerCase();
    const txs = transactions.filter((t) => {
      if (filter !== "ALL" && t.status !== filter) return false;
      if (!q) return true;
      return [t.id, t.to, t.from, t.walletId, t.purpose, t.nonce]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });
    const sorted = [...txs].sort((a, b) => b.requestedAt - a.requestedAt);
    const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
    return { rows: sorted, totalPages, total: sorted.length };
  }, [transactions, filter, query]);

  const rows = pages.rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

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

      <div className="flex gap-2 items-center justify-between flex-wrap">
        <div className="flex gap-2">
          {filters.map((f) => (
            <Button
              key={f}
              variant={filter === f ? "primary" : "outline"}
              size="sm"
              onClick={() => {
                setFilter(f);
                setPage(0);
              }}
            >
              {f}
            </Button>
          ))}
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
            placeholder="search id / to / purpose…"
            className="pl-8 pr-3 py-1.5 rounded-lg border border-border bg-panel font-mono text-xs text-foreground placeholder:text-muted outline-none focus:border-info/50"
          />
        </div>
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
          {pages.total === 0 ? (
            <div className="px-4 py-12 text-center font-mono text-sm text-muted">
              no transactions{filter !== "ALL" ? ` with status ${filter}` : ""}
              {query.trim() ? ` matching "${query}"` : ""}
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

      <div className="flex items-center justify-between font-mono text-xs text-muted">
        <span>
          {pages.total} tx{pages.total === 1 ? "" : "s"} · page {page + 1}/{pages.totalPages}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Prev
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page + 1 >= pages.totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
