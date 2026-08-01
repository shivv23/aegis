/**
 * Fee schedule + metering billing (A6).
 *
 * Every settled transaction already records a `usage` row (P0.5 metering);
 * this module attaches a per-rail fee to those rows and aggregates them into
 * per-wallet invoices with one line per rail.
 *
 * Fee schedule defaults (bps = basis points, 100 bps = 1%):
 *   sandbox      0 bps (demo rail, free)
 *   usdc-testnet 15 bps (0.15%)
 *   ach-lite     50 bps (0.50%)
 *   flat minimum $0.01 applied to paid rails
 *
 * Overridable via AEGIS_FEE_USDC_BPS, AEGIS_FEE_ACH_BPS, AEGIS_FEE_SANDBOX_BPS
 * and AEGIS_FEE_FLAT_MIN.
 */
import { randomUUID } from "node:crypto";
import { getStore } from "./store";
import type { Invoice, InvoiceLine } from "./types";

export interface FeeSchedule {
  bps: number;
  minUsd: number;
}

function envNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function feeScheduleFor(rail: string): FeeSchedule {
  switch (rail) {
    case "usdc-testnet":
      return { bps: envNumber("AEGIS_FEE_USDC_BPS", 15), minUsd: envNumber("AEGIS_FEE_FLAT_MIN", 0.01) };
    case "ach-lite":
      return { bps: envNumber("AEGIS_FEE_ACH_BPS", 50), minUsd: envNumber("AEGIS_FEE_FLAT_MIN", 0.01) };
    default:
      return { bps: envNumber("AEGIS_FEE_SANDBOX_BPS", 0), minUsd: 0 };
  }
}

export function feeScheduleTable(): { rail: string; bps: number; minUsd: number }[] {
  return ["sandbox", "usdc-testnet", "ach-lite"].map((rail) => {
    const s = feeScheduleFor(rail);
    return { rail, bps: s.bps, minUsd: s.minUsd };
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Fee in USD for a settlement amount on a rail. Free rails stay free. */
export function computeFee(rail: string, amountUsd: number): number {
  const s = feeScheduleFor(rail);
  if (s.bps === 0) return 0;
  const fee = (amountUsd * s.bps) / 10000;
  return round2(Math.max(fee, s.minUsd));
}

export interface InvoiceRow {
  id: string;
  walletId: string;
  periodStart: number;
  periodEnd: number;
  status: "draft" | "finalized";
  totalUsd: number;
  totalFeeUsd: number;
  createdAt: number;
}

function rowToInvoice(r: Record<string, unknown>): InvoiceRow {
  return {
    id: r.id as string,
    walletId: r.wallet_id as string,
    periodStart: Number(r.period_start),
    periodEnd: Number(r.period_end),
    status: r.status as InvoiceRow["status"],
    totalUsd: Number(r.total_usd),
    totalFeeUsd: Number(r.total_fee_usd),
    createdAt: Number(r.created_at),
  };
}

async function linesFor(invoiceId: string): Promise<InvoiceLine[]> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute(
    "SELECT rail, amount_usd, fee_usd FROM invoice_lines WHERE invoice_id = ? ORDER BY rail",
    [invoiceId],
  );
  return rows.map((r) => ({
    rail: r.rail as string,
    amountUsd: Number(r.amount_usd),
    feeUsd: Number(r.fee_usd),
  }));
}

/** Fetches an invoice with its lines. */
export async function getInvoice(id: string): Promise<Invoice | null> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute(
    "SELECT * FROM invoices WHERE id = ?",
    [id],
  );
  if (rows.length === 0) return null;
  const inv = rowToInvoice(rows[0] as Record<string, unknown>);
  return { ...inv, lines: await linesFor(id) };
}

export async function listInvoices(): Promise<Invoice[]> {
  const s = getStore();
  await s.ready;
  const { rows } = await s.client.execute(
    "SELECT * FROM invoices ORDER BY created_at DESC LIMIT 100",
  );
  const invoices: Invoice[] = [];
  for (const row of rows) {
    const inv = rowToInvoice(row as Record<string, unknown>);
    invoices.push({ ...inv, lines: await linesFor(inv.id) });
  }
  return invoices;
}

/**
 * Generates a draft invoice aggregating usage rows in [periodStart, periodEnd)
 * for a wallet. Idempotent: an existing invoice for the exact window is
 * returned unchanged rather than double-billed.
 */
export async function generateInvoice(input: {
  walletId: string;
  periodStart: number;
  periodEnd: number;
}): Promise<Invoice | null> {
  const s = getStore();
  await s.ready;
  const { walletId, periodStart, periodEnd } = input;

  const existing = await s.client.execute(
    "SELECT id FROM invoices WHERE wallet_id = ? AND period_start = ? AND period_end = ?",
    [walletId, periodStart, periodEnd],
  );
  if (existing.rows.length > 0) {
    return getInvoice(existing.rows[0].id as string);
  }

  const { rows } = await s.client.execute(
    "SELECT rail, amount, fee FROM usage WHERE wallet_id = ? AND created_at >= ? AND created_at < ?",
    [walletId, periodStart, periodEnd],
  );
  if (rows.length === 0) return null;

  const byRail = new Map<string, { amountUsd: number; feeUsd: number }>();
  for (const r of rows) {
    const rail = r.rail as string;
    const cur = byRail.get(rail) ?? { amountUsd: 0, feeUsd: 0 };
    cur.amountUsd += Number(r.amount);
    cur.feeUsd += Number(r.fee ?? 0);
    byRail.set(rail, cur);
  }

  const lines: InvoiceLine[] = [...byRail.entries()].map(([rail, v]) => ({
    rail,
    amountUsd: round2(v.amountUsd),
    feeUsd: round2(v.feeUsd),
  }));
  const totalUsd = round2(lines.reduce((acc, l) => acc + l.amountUsd, 0));
  const totalFeeUsd = round2(lines.reduce((acc, l) => acc + l.feeUsd, 0));

  const id = randomUUID();
  await s.client.execute(
    "INSERT INTO invoices (id, wallet_id, period_start, period_end, status, total_usd, total_fee_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [id, walletId, periodStart, periodEnd, "draft", totalUsd, totalFeeUsd, Date.now()],
  );
  for (const line of lines) {
    await s.client.execute(
      "INSERT INTO invoice_lines (invoice_id, rail, amount_usd, fee_usd) VALUES (?, ?, ?, ?)",
      [id, line.rail, line.amountUsd, line.feeUsd],
    );
  }
  return getInvoice(id);
}

/** Marks a draft invoice finalized. */
export async function finalizeInvoice(id: string): Promise<Invoice | null> {
  const s = getStore();
  await s.ready;
  await s.client.execute(
    "UPDATE invoices SET status = 'finalized' WHERE id = ? AND status = 'draft'",
    [id],
  );
  return getInvoice(id);
}
