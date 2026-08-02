"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ownerApi } from "@/lib/api-client";
import { clock, cn } from "@/lib/utils";
import type { AuditLogEntry } from "@/core/types";

const PAGE_SIZE = 100;

export default function AuditPage() {
  const [rows, setRows] = useState<AuditLogEntry[]>([]);
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requested = useRef(0);

  const loadPage = useCallback(async (cursor: string | null) => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (submittedSearch) params.set("search", submittedSearch);
    if (cursor) params.set("cursor", cursor);
    const data = await ownerApi<{ audit: AuditLogEntry[]; nextCursor: string | null }>(
      `/api/audit?${params.toString()}`,
    );
    return data;
  }, [submittedSearch]);

  const fetchFirst = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      requested.current += 1;
      const data = await loadPage(null);
      setRows(data.audit);
      setNextCursor(data.nextCursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [loadPage]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await loadPage(nextCursor);
      setRows((prev) => [...prev, ...data.audit]);
      setNextCursor(data.nextCursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, loadPage]);

  useEffect(() => {
    void fetchFirst();
  }, [fetchFirst]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmittedSearch(search.trim());
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-mono text-xl font-bold tracking-tight">Audit Trail</h1>
        <p className="text-sm text-muted">
          Append-only, actor-stamped accountability. There is no legal recourse
          with an agent — so every action is a fact.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <form onSubmit={onSubmit} className="flex min-w-0 flex-1 items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search action, details or wallet…"
            className="min-w-0 flex-1 rounded-lg border border-border bg-panel px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-accent"
          />
          <button
            type="submit"
            className="rounded-lg bg-accent px-3 py-2 font-mono text-xs font-semibold text-panel hover:opacity-90"
          >
            Search
          </button>
        </form>
        <button
          onClick={() => {
            setSubmittedSearch("");
            setSearch("");
          }}
          className="rounded-lg border border-border px-3 py-2 font-mono text-xs text-muted hover:text-foreground"
        >
          Clear
        </button>
        <button
          onClick={() => void fetchFirst()}
          disabled={loading}
          className="rounded-lg border border-border px-3 py-2 font-mono text-xs text-muted hover:text-foreground disabled:opacity-50"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-panel/70">
        <div className="grid grid-cols-12 gap-2 border-b border-border px-4 py-2.5 font-mono text-[10px] uppercase tracking-widest text-muted">
          <span className="col-span-2">Time</span>
          <span className="col-span-2">Actor</span>
          <span className="col-span-3">Action</span>
          <span className="col-span-5">Details</span>
        </div>
        <div className="max-h-[640px] overflow-y-auto">
          {loading ? (
            <div className="px-4 py-12 text-center font-mono text-sm text-muted">
              loading audit trail…
            </div>
          ) : rows.length === 0 ? (
            <div className="px-4 py-12 text-center font-mono text-sm text-muted">
              {submittedSearch
                ? `no audit entries match "${submittedSearch}"`
                : "no audit entries"}
            </div>
          ) : (
            rows.map((e) => (
              <div
                key={e.id}
                className="grid grid-cols-12 items-start gap-2 border-b border-border/60 px-4 py-2.5 font-mono text-xs leading-relaxed last:border-0"
              >
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
                <span className="col-span-5 break-words text-foreground">
                  {e.details}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] text-muted">
          {rows.length} loaded{submittedSearch ? ` · filtering "${submittedSearch}"` : ""}
          {nextCursor ? "" : " · end of trail"}
        </span>
        {nextCursor ? (
          <button
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="rounded-lg border border-border px-3 py-2 font-mono text-xs text-muted hover:text-foreground disabled:opacity-50"
          >
            {loadingMore ? "Loading…" : "Load older"}
          </button>
        ) : null}
      </div>

      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 px-4 py-2 font-mono text-xs text-danger">
          {error}
        </div>
      ) : null}
    </div>
  );
}
