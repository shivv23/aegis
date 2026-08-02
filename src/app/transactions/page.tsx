"use client";

import { useMemo, useState } from "react";
import { useStream } from "@/hooks/use-stream";
import { Button, Card, Field, Reason, TxBadge } from "@/components/ui";
import {
  batchTransfer,
  createRecurringSchedule,
  deleteRecurringScheduleApi,
  deleteSearchApi,
  fetchTimeline,
  listRecurringSchedulesApi,
  listSavedSearchesApi,
  ownerApi,
  runRecurringNow,
  saveSearchApi,
} from "@/lib/api-client";
import { clock, money, shortId } from "@/lib/utils";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Loader2,
  PauseCircle,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type { Transaction } from "@/core/types";

const PAGE_SIZE = 10;
const DEFAULT_WALLET = "wallet-tradingbot-42";

interface Schedule {
  id: string;
  walletId: string;
  to: string;
  amount: number;
  purpose: string;
  everyHours: number;
  dailyHour?: number;
  nextRunAt: number;
  createdAt: number;
  active: boolean;
  lastRunAt?: number;
  runCount: number;
}

interface BatchRow {
  index: number;
  to: string;
  amount: number;
  status: string;
  reason?: string;
  details?: string;
  txId?: string;
  purpose?: string;
}

interface TimelineData {
  hops: Array<{ label: string; ts: number; detail?: string }>;
  latencyMs?: number;
  outcome: string;
}

export default function TransactionsPage() {
  const { transactions } = useStream();
  const [filter, setFilter] = useState<string>("ALL");
  const [query, setQuery] = useState<string>("");
  const [page, setPage] = useState<number>(0);

  // ---- batch ----
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchWallet, setBatchWallet] = useState(DEFAULT_WALLET);
  const [batchText, setBatchText] = useState("");
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchResult, setBatchResult] = useState<{
    batchKey: string;
    results: BatchRow[];
    summary: { total: number; pending: number; settled: number; stepUp: number; blocked: number };
  } | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);

  // ---- recurring ----
  const [recurringOpen, setRecurringOpen] = useState(false);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [schedBusy, setSchedBusy] = useState(false);
  const [schedTo, setSchedTo] = useState("compute:0xCAFE0001");
  const [schedAmount, setSchedAmount] = useState("120");
  const [schedEvery, setSchedEvery] = useState("24");
  const [schedDailyHour, setSchedDailyHour] = useState("");
  const [schedMessage, setSchedMessage] = useState<string | null>(null);

  // ---- timeline drawer ----
  const [timelineTx, setTimelineTx] = useState<Transaction | null>(null);
  const [timeline, setTimeline] = useState<TimelineData | null>(null);
  const [timelineBusy, setTimelineBusy] = useState(false);

  // ---- saved searches ----
  const [savedOpen, setSavedOpen] = useState(false);
  const [saved, setSaved] = useState<Array<{ id: string; name: string; filters: Record<string, unknown>; createdAt: number }>>([]);
  const [saveName, setSaveName] = useState("");
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

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

  async function loadDemoPayroll() {
    setBatchText(
      [
        "350,compute:0xCAFE0001,GPU burst",
        "600,compute:0xCAFE0001,attempt: over per-tx cap",
        "85,drain:0xBADBEEF,attempt: unapproved payee",
        "120,compute:0xCAFE0001,GPU burst 2",
        "4200,api:0xBEEF0002,attempt: exhaust daily limit",
      ].join("\n"),
    );
  }

  async function runBatch() {
    const transfers = batchText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [amount, to, purpose] = line.split(",");
        return { amount: Number(amount), to: to.trim(), purpose: (purpose ?? "").trim() || undefined };
      })
      .filter((r) => Number.isFinite(r.amount) && r.to);
    if (transfers.length === 0) {
      setBatchError("No valid rows. Format: amount,to,purpose");
      return;
    }
    setBatchBusy(true);
    setBatchError(null);
    try {
      const res = await batchTransfer(batchWallet, transfers);
      setBatchResult(res);
    } catch (e) {
      setBatchError(e instanceof Error ? e.message : "Batch failed");
    } finally {
      setBatchBusy(false);
    }
  }

  async function loadSchedules() {
    setSchedBusy(true);
    setSchedMessage(null);
    try {
      const res = await listRecurringSchedulesApi();
      setSchedules(res.schedules as Schedule[]);
    } catch (e) {
      setSchedMessage(`Error: ${e instanceof Error ? e.message : "load failed"}`);
    } finally {
      setSchedBusy(false);
    }
  }

  async function createSchedule() {
    setSchedBusy(true);
    setSchedMessage(null);
    try {
      await createRecurringSchedule({
        walletId: batchWallet,
        to: schedTo,
        amount: Number(schedAmount),
        purpose: "recurring",
        everyHours: Number(schedEvery),
        dailyHour: schedDailyHour ? Number(schedDailyHour) : undefined,
      });
      setSchedMessage("Schedule created. Next run re-evaluates the guard.");
      await loadSchedules();
    } catch (e) {
      setSchedMessage(`Error: ${e instanceof Error ? e.message : "create failed"}`);
    } finally {
      setSchedBusy(false);
    }
  }

  async function removeSchedule(id: string) {
    await deleteRecurringScheduleApi(id);
    setSchedules((s) => s.filter((x) => x.id !== id));
  }

  async function runDue() {
    setSchedBusy(true);
    setSchedMessage(null);
    try {
      const res = await runRecurringNow();
      setSchedMessage(`Ran ${res.ran} due schedule${res.ran === 1 ? "" : "s"} through the guard.`);
      await loadSchedules();
    } catch (e) {
      setSchedMessage(`Error: ${e instanceof Error ? e.message : "run failed"}`);
    } finally {
      setSchedBusy(false);
    }
  }

  async function openTimeline(tx: Transaction) {
    setTimelineTx(tx);
    setTimeline(null);
    setTimelineBusy(true);
    try {
      const res = await fetchTimeline(tx.id);
      setTimeline(res.timeline as unknown as TimelineData);
    } catch {
      setTimeline({ hops: [], outcome: "ERROR" });
    } finally {
      setTimelineBusy(false);
    }
  }

  async function loadSaved() {
    const res = await listSavedSearchesApi();
    setSaved(res.searches);
  }

  async function saveCurrent() {
    const name = saveName.trim() || `${filter} ${query.trim() ? `"${query.trim()}"` : ""}`.trim();
    if (!name) return;
    await saveSearchApi(name, { status: filter === "ALL" ? undefined : filter, query: query.trim() || undefined });
    setSaveMsg(`Saved "${name}".`);
    setSaveName("");
    await loadSaved();
  }

  async function applySaved(s: { filters: Record<string, unknown> }) {
    const f = s.filters as { status?: string; query?: string };
    setFilter(f.status ?? "ALL");
    setQuery(f.query ?? "");
    setPage(0);
    setSavedOpen(false);
  }

  async function removeSaved(id: string) {
    await deleteSearchApi(id);
    setSaved((s) => s.filter((x) => x.id !== id));
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="font-mono text-xl font-bold tracking-tight">Transactions</h1>
          <p className="text-sm text-muted">
            Every money movement passes through the guard. Nothing happens off-ledger.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => { setBatchOpen(!batchOpen); }}>
            Batch transfers
          </Button>
          <Button variant="outline" size="sm" onClick={() => { setRecurringOpen(!recurringOpen); }}>
            Recurring
          </Button>
        </div>
      </header>

      {batchOpen ? (
        <Card className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="font-mono text-xs uppercase tracking-widest text-muted">
              Batch payroll — every row runs through the same guard
            </div>
            <Button variant="outline" size="sm" onClick={loadDemoPayroll}>
              Load demo payroll (5 rows)
            </Button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Field label="Wallet" value={batchWallet} onChange={(e) => setBatchWallet(e.target.value)} />
            <div className="md:col-span-2">
              <textarea
                value={batchText}
                onChange={(e) => setBatchText(e.target.value)}
                rows={4}
                placeholder={"amount,to,purpose   (one per line)\n350,compute:0xCAFE0001,GPU burst"}
                className="w-full rounded-md border border-border bg-black/40 px-3 py-2 text-sm font-mono text-foreground outline-none focus:border-accent/60"
              />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={() => void runBatch()} disabled={batchBusy}>
              {batchBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              Run batch
            </Button>
            {batchError ? <span className="font-mono text-xs text-danger">{batchError}</span> : null}
            {batchResult ? (
              <span className="font-mono text-xs text-muted">
                {batchResult.summary.settled} settled · {batchResult.summary.pending} pending ·{" "}
                {batchResult.summary.stepUp} step-up · {batchResult.summary.blocked} blocked
              </span>
            ) : null}
          </div>
          {batchResult ? (
            <div className="rounded-lg border border-border bg-black/30 overflow-hidden">
              <div className="grid grid-cols-8 gap-2 px-3 py-2 border-b border-border font-mono text-[10px] uppercase tracking-widest text-muted">
                <span className="col-span-2">To</span>
                <span className="col-span-2">Amount</span>
                <span className="col-span-2">Purpose</span>
                <span className="col-span-2 text-right">Status</span>
              </div>
              <div className="max-h-64 overflow-y-auto">
                {batchResult.results.map((r) => (
                  <div key={r.index} className="grid grid-cols-8 gap-2 items-center px-3 py-1.5 border-b border-border/50 font-mono text-xs">
                    <span className="col-span-2 text-info truncate">{shortId(r.to, 22)}</span>
                    <span className="col-span-2">{money(r.amount)}</span>
                    <span className="col-span-2 text-muted truncate">{r.purpose}</span>
                    <span className="col-span-2 text-right">
                      <span
                        className={
                          r.status === "SETTLED"
                            ? "text-accent"
                            : r.status === "BLOCKED"
                              ? "text-danger"
                              : r.status === "STEP_UP_REQUIRED"
                                ? "text-orange-300"
                                : "text-warn"
                        }
                      >
                        {r.status}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
              <div className="px-3 py-2 border-t border-border font-mono text-[10px] text-muted">
                batch {batchResult.batchKey}
              </div>
            </div>
          ) : null}
        </Card>
      ) : null}

      {recurringOpen ? (
        <Card className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="font-mono text-xs uppercase tracking-widest text-muted">
              Recurring transfers — re-evaluated by the guard at execution time
            </div>
            <Button variant="outline" size="sm" onClick={loadSchedules}>
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 items-end">
            <Field label="To" value={schedTo} onChange={(e) => setSchedTo(e.target.value)} />
            <Field label="Amount" type="number" value={schedAmount} onChange={(e) => setSchedAmount(e.target.value)} />
            <Field label="Every (hours)" type="number" value={schedEvery} onChange={(e) => setSchedEvery(e.target.value)} />
            <Field label="Daily hour (0-23)" type="number" value={schedDailyHour} onChange={(e) => setSchedDailyHour(e.target.value)} />
            <Button variant="warn" size="sm" onClick={() => void createSchedule()} disabled={schedBusy}>
              Create schedule
            </Button>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" onClick={() => void runDue()} disabled={schedBusy}>
              <Clock className="h-3.5 w-3.5" /> Run due now
            </Button>
            {schedMessage ? <span className="font-mono text-xs text-muted">{schedMessage}</span> : null}
          </div>
          {schedules.length > 0 ? (
            <div className="rounded-lg border border-border bg-black/30 overflow-hidden">
              <div className="grid grid-cols-12 gap-2 px-3 py-2 border-b border-border font-mono text-[10px] uppercase tracking-widest text-muted">
                <span className="col-span-3">To</span>
                <span className="col-span-2">Amount</span>
                <span className="col-span-2">Cadence</span>
                <span className="col-span-3">Next run</span>
                <span className="col-span-1 text-right">Runs</span>
                <span className="col-span-1 text-right"> </span>
              </div>
              <div className="max-h-64 overflow-y-auto">
                {schedules.map((s) => (
                  <div key={s.id} className="grid grid-cols-12 gap-2 items-center px-3 py-1.5 border-b border-border/50 font-mono text-xs">
                    <span className="col-span-3 text-info truncate">{shortId(s.to, 22)}</span>
                    <span className="col-span-2">{money(s.amount)}</span>
                    <span className="col-span-2 text-muted">
                      {s.dailyHour != null ? `daily ${s.dailyHour}:00` : `every ${s.everyHours}h`}
                    </span>
                    <span className="col-span-3 text-muted">{clock(s.nextRunAt)}</span>
                    <span className="col-span-1 text-right">{s.runCount}</span>
                    <span className="col-span-1 flex justify-end">
                      <button onClick={() => void removeSchedule(s.id)} className="text-danger hover:opacity-70">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="font-mono text-xs text-muted">
              No schedules yet. Create one and it runs automatically on cron.
            </div>
          )}
        </Card>
      ) : null}

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
        <div className="relative flex items-center gap-2">
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
          <div className="relative">
            <Button variant="outline" size="sm" onClick={() => { setSavedOpen(!savedOpen); void loadSaved(); }}>
              <Save className="h-3.5 w-3.5" /> Saved
            </Button>
            {savedOpen ? (
              <div className="absolute right-0 z-30 mt-2 w-72 rounded-lg border border-border bg-panel p-3 shadow-xl">
                <div className="mb-2 flex gap-2">
                  <input
                    value={saveName}
                    onChange={(e) => setSaveName(e.target.value)}
                    placeholder="name this filter…"
                    className="flex-1 rounded-md border border-border bg-black/40 px-2 py-1 text-xs font-mono outline-none focus:border-accent/60"
                  />
                  <Button variant="primary" size="sm" onClick={() => void saveCurrent()}>
                    Save
                  </Button>
                </div>
                {saveMsg ? <div className="mb-2 font-mono text-[10px] text-accent">{saveMsg}</div> : null}
                {saved.length === 0 ? (
                  <div className="font-mono text-[11px] text-muted">no saved searches</div>
                ) : (
                  saved.map((s) => (
                    <div key={s.id} className="flex items-center justify-between gap-2 py-1">
                      <button
                        className="flex-1 text-left font-mono text-[11px] text-info hover:text-accent"
                        onClick={() => void applySaved(s)}
                      >
                        {s.name}
                      </button>
                      <button onClick={() => void removeSaved(s.id)} className="text-danger hover:opacity-70">
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  ))
                )}
              </div>
            ) : null}
          </div>
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
                <button
                  className="col-span-3 text-left group"
                  onClick={() => void openTimeline(tx)}
                  title="Open transaction timeline"
                >
                  <span className="text-foreground group-hover:text-info">{money(tx.amount)}</span>
                  <span className="text-muted"> → </span>
                  <span className="text-info">{shortId(tx.to, 20)}</span>
                  {tx.kind && tx.kind !== "transfer" ? (
                    <span className="ml-1 rounded border border-border px-1 text-[9px] text-muted">{tx.kind}</span>
                  ) : null}
                </button>
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

      {timelineTx ? (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/60"
          onClick={() => setTimelineTx(null)}
        >
          <div
            className="w-full max-w-md h-full overflow-y-auto border-l border-border bg-panel p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <div className="font-mono text-sm font-bold">
                Transaction timeline
              </div>
              <button onClick={() => setTimelineTx(null)} className="text-muted hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mb-4 space-y-1 font-mono text-[11px] text-muted">
              <div>
                {money(timelineTx.amount)} → <span className="text-info">{shortId(timelineTx.to, 24)}</span>
              </div>
              <div>purpose: {timelineTx.purpose}</div>
              <div>requested: {clock(timelineTx.requestedAt)}</div>
              <div>outcome: <span className="text-accent">{timeline?.outcome ?? timelineTx.status}</span></div>
              {timeline?.latencyMs != null ? (
                <div>end-to-end: {timeline.latencyMs}ms</div>
              ) : null}
            </div>
            {timelineBusy ? (
              <div className="flex items-center gap-2 font-mono text-xs text-muted">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> loading timeline…
              </div>
            ) : timeline?.hops.length ? (
              <div className="space-y-0">
                {timeline.hops.map((h, i) => (
                  <div key={i} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <div
                        className={
                          h.label === "BLOCKED" || h.label === "REVOKED"
                            ? "h-2.5 w-2.5 rounded-full bg-danger"
                            : h.label === "SETTLED"
                              ? "h-2.5 w-2.5 rounded-full bg-accent"
                              : "h-2.5 w-2.5 rounded-full bg-warn"
                        }
                      />
                      {i < timeline.hops.length - 1 ? <div className="w-px flex-1 bg-border" /> : null}
                    </div>
                    <div className="pb-5">
                      <div className="font-mono text-xs font-semibold text-foreground">{h.label}</div>
                      <div className="font-mono text-[10px] text-muted">{clock(h.ts)}</div>
                      {h.detail ? (
                        <div className="mt-0.5 font-mono text-[10px] text-muted">{h.detail}</div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="font-mono text-xs text-muted">no timeline hops recorded</div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
