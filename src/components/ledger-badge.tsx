"use client";

import { useEffect, useState } from "react";
import { ownerApi } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { ShieldCheck, ShieldAlert, Loader2 } from "lucide-react";

/**
 * Live tamper-evidence: polls /api/ledger/verify and shows whether the
 * hash chain is intact. Any edit to a stored ledger row flips this red.
 */
export function LedgerBadge() {
  const [state, setState] = useState<{
    checking: boolean;
    intact?: boolean;
    rows?: number;
  }>({ checking: true });

  useEffect(() => {
    let alive = true;
    async function check() {
      try {
        const proof = await ownerApi<{ intact: boolean; rows: number }>(
          "/api/ledger/verify",
        );
        if (alive) setState({ checking: false, intact: proof.intact, rows: proof.rows });
      } catch {
        if (alive) setState({ checking: false, intact: undefined });
      }
    }
    void check();
    const t = setInterval(check, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (state.checking) {
    return (
      <span className="flex items-center gap-1.5 rounded-md border border-muted bg-muted/20 px-2 py-1 font-mono text-[11px] text-muted">
        <Loader2 className="h-3 w-3 animate-spin" /> verifying ledger…
      </span>
    );
  }

  const intact = state.intact === true;
  return (
    <span
      title={
        intact
          ? `${state.rows} chained ledger entries — every one cryptographically linked`
          : "LEDGER TAMPERED — hash chain broken!"
      }
      className={cn(
        "flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[11px]",
        intact
          ? "border-accent/40 bg-accent/10 text-accent"
          : "border-danger/50 bg-danger/15 text-danger",
      )}
    >
      {intact ? (
        <ShieldCheck className="h-3 w-3" />
      ) : (
        <ShieldAlert className="h-3 w-3" />
      )}
      {intact ? `LEDGER INTACT · ${state.rows} entries` : "LEDGER TAMPERED"}
    </span>
  );
}
