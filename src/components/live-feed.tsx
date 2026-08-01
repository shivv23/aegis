import type { Transaction } from "@/core/types";
import { clock, money, shortId } from "@/lib/utils";
import { Reason, TxBadge } from "./ui";

export function TxRow({ tx }: { tx: Transaction }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2 text-sm border-b border-border/60 last:border-0 hover:bg-white/[0.03]">
      <span className="font-mono text-muted w-20 shrink-0 text-[11px]">
        {clock(tx.requestedAt)}
      </span>
      <span className="font-mono text-xs text-muted w-20 shrink-0">
        {shortId(tx.walletId)}
      </span>
      <span className="flex-1 min-w-0 truncate">
        <span className="text-foreground">{money(tx.amount)}</span>
        <span className="text-muted"> → </span>
        <span className="font-mono text-xs text-info">{shortId(tx.to, 18)}</span>
      </span>
      <span className="w-28 shrink-0 text-right">
        <TxBadge status={tx.status} />
      </span>
      <span className="w-36 shrink-0 text-right">
        <Reason reason={tx.rejectionReason} />
      </span>
    </div>
  );
}

export function LiveFeed({ transactions }: { transactions: Transaction[] }) {
  const rows = transactions.slice(0, 30);
  return (
    <div className="rounded-xl border border-border bg-panel/70 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-accent cursor-blink" />
          <span className="font-mono text-xs uppercase tracking-widest text-muted">
            Live transaction feed
          </span>
        </div>
        <span className="font-mono text-[11px] text-muted">
          {transactions.length} total
        </span>
      </div>
      <div className="max-h-[480px] overflow-y-auto">
        {rows.length === 0 ? (
          <div className="px-4 py-10 text-center font-mono text-sm text-muted">
            awaiting traffic…
          </div>
        ) : (
          rows.map((tx) => <TxRow key={tx.id} tx={tx} />)
        )}
      </div>
    </div>
  );
}
