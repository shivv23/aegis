"use client";

import { useMemo } from "react";
import { useStream } from "@/hooks/use-stream";
import { clock } from "@/lib/utils";
import { cn } from "@/lib/utils";

export default function AuditPage() {
  const { audit } = useStream();

  const rows = useMemo(() => audit.slice(0, 200), [audit]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-mono text-xl font-bold tracking-tight">Audit Trail</h1>
        <p className="text-sm text-muted">
          Append-only, actor-stamped accountability. There is no legal recourse
          with an agent — so every action is a fact.
        </p>
      </header>

      <div className="rounded-xl border border-border bg-panel/70 overflow-hidden">
        <div className="grid grid-cols-12 gap-2 px-4 py-2.5 border-b border-border font-mono text-[10px] uppercase tracking-widest text-muted">
          <span className="col-span-2">Time</span>
          <span className="col-span-2">Actor</span>
          <span className="col-span-3">Action</span>
          <span className="col-span-5">Details</span>
        </div>
        <div className="max-h-[640px] overflow-y-auto">
          {rows.length === 0 ? (
            <div className="px-4 py-12 text-center font-mono text-sm text-muted">
              no audit entries
            </div>
          ) : (
            rows.map((e) => (
              <div key={e.id} className="grid grid-cols-12 gap-2 items-start px-4 py-2.5 border-b border-border/60 last:border-0 font-mono text-xs leading-relaxed">
                <span className="col-span-2 text-muted">{clock(e.timestamp)}</span>
                <span
                  className={cn(
                    "col-span-2 font-bold",
                    e.actor === "owner"
                      ? "text-accent"
                      : e.actor === "agent"
                        ? "text-info"
                        : "text-muted",
                  )}
                >
                  {e.actor.toUpperCase()}
                </span>
                <span className="col-span-3 text-warn">{e.action}</span>
                <span className="col-span-5 text-foreground break-words">
                  {e.details}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
