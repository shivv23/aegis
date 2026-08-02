"use client";

import type { Wallet } from "@/core/types";

const OWNER_KEY = "aegis-owner-key";

export interface Bootstrap {
  ownerKey: string;
  seedWalletId: string | null;
  seeded: boolean;
  signers: Array<{ id: string; name: string; role: string; key: string }>;
}

const SIGNER_KEYS = "aegis-signer-keys";

export async function getBootstrap(): Promise<Bootstrap> {
  const res = await fetch("/api/bootstrap");
  if (!res.ok) throw new Error("Bootstrap failed");
  return res.json();
}

export async function getSignerKeys(): Promise<Bootstrap["signers"]> {
  const cached = localStorage.getItem(SIGNER_KEYS);
  if (cached) return JSON.parse(cached);
  const b = await getBootstrap();
  localStorage.setItem(SIGNER_KEYS, JSON.stringify(b.signers));
  return b.signers;
}

export async function signerApi<T = unknown>(
  signerKey: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${signerKey}`,
      ...(init.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `Request failed: ${res.status}`);
  }
  return data as T;
}

export async function ensureOwnerKey(): Promise<string> {
  const existing = localStorage.getItem(OWNER_KEY);
  if (existing) return existing;
  const b = await getBootstrap();
  localStorage.setItem(OWNER_KEY, b.ownerKey);
  return b.ownerKey;
}

export function getOwnerKey(): string | null {
  return localStorage.getItem(OWNER_KEY);
}

export function clearOwnerKey(): void {
  localStorage.removeItem(OWNER_KEY);
}

export async function ownerApi<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const key = await ensureOwnerKey();
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      ...(init.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `Request failed: ${res.status}`);
  }
  return data as T;
}

export async function agentTransfer(
  agentKey: string,
  body: { to: string; amount: number; purpose?: string },
): Promise<unknown> {
  const res = await fetch("/api/rail/transfer", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${agentKey}`,
    },
    body: JSON.stringify({ ...body, nonce: crypto.randomUUID() }),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, ...data };
}

export async function mintKeys(walletId: string) {
  return ownerApi<{ ownerKey: string; walletOwnerKey: string; agentKey: string }>(
    `/api/keys?walletId=${encodeURIComponent(walletId)}`,
  );
}

export async function listAgentKeys(walletId: string) {
  return ownerApi<{
    agentKeys: Array<{
      publicKey: string;
      label: string;
      createdAt: number;
      expiresAt: number | null;
      lastUsedAt: number | null;
      revokedAt: number | null;
      acl?: { actions: string[] };
    }>;
  }>(`/api/keys?walletId=${encodeURIComponent(walletId)}`);
}

export async function rotateAgentKey(walletId: string, oldPublicKey: string) {
  return ownerApi<{ publicKey: string; privateKey: string; label: string }>(
    "/api/keys/rotate",
    { method: "POST", body: JSON.stringify({ walletId, oldPublicKey }) },
  );
}

export async function revokeAgentKey(walletId: string, publicKey: string) {
  return ownerApi<{ ok: boolean }>("/api/keys/revoke", {
    method: "POST",
    body: JSON.stringify({ walletId, publicKey }),
  });
}

export async function createWallet(input: {
  name: string;
  ownerDid: string;
  balance: number;
  maxPerTx: number;
  dailyLimit: number;
  monthlyLimit: number;
  velocityLimitPerMin: number;
  allowlist: string[];
}) {
  return ownerApi<{ wallet: Wallet; agentKey: string; ownerKey: string }>(
    "/api/wallet",
    {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        ownerDid: input.ownerDid,
        balance: input.balance,
        policy: {
          maxPerTx: input.maxPerTx,
          dailyLimit: input.dailyLimit,
          monthlyLimit: input.monthlyLimit,
          velocityLimitPerMin: input.velocityLimitPerMin,
          allowlist: input.allowlist,
        },
      }),
    },
  );
}

// ── Round 2: batch, recurring, funding, chaos, searches, timeline ──────────

export async function batchTransfer(
  walletId: string,
  transfers: Array<{ to: string; amount: number; purpose?: string }>,
) {
  return ownerApi<{
    batchKey: string;
    results: Array<{
      index: number;
      to: string;
      amount: number;
      status: string;
      reason?: string;
      details?: string;
      txId?: string;
    }>;
    summary: {
      total: number;
      pending: number;
      settled: number;
      stepUp: number;
      blocked: number;
    };
  }>("/api/rail/batch", {
    method: "POST",
    body: JSON.stringify({
      walletId,
      transfers,
      idempotencyKey: `batch:${crypto.randomUUID()}`,
    }),
  });
}

export async function createRecurringSchedule(input: {
  walletId: string;
  to: string;
  amount: number;
  purpose?: string;
  everyHours: number;
  dailyHour?: number;
}) {
  return ownerApi<{ schedule: unknown }>("/api/rail/recurring", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function listRecurringSchedulesApi(walletId?: string) {
  const q = walletId ? `?walletId=${encodeURIComponent(walletId)}` : "";
  return ownerApi<{ schedules: unknown[] }>(`/api/rail/recurring${q}`);
}

export async function deleteRecurringScheduleApi(id: string) {
  return ownerApi<{ ok: boolean }>(`/api/rail/recurring/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function runRecurringNow() {
  return ownerApi<{ ran: number; results: unknown[] }>("/api/rail/recurring/run", {
    method: "POST",
  });
}

export async function deposit(walletId: string, amount: number, method = "wire") {
  return ownerApi<{ status: string; simulated: boolean; transaction: unknown; newBalance: number }>(
    "/api/rail/fund",
    { method: "POST", body: JSON.stringify({ walletId, amount, method }) },
  );
}

export async function withdraw(
  walletId: string,
  amount: number,
  destination: string,
) {
  return ownerApi<{ status: string; simulated: boolean; transaction: unknown; newBalance: number }>(
    "/api/rail/withdraw",
    { method: "POST", body: JSON.stringify({ walletId, amount, destination }) },
  );
}

export async function runChaos(
  walletId: string,
  count: number,
  mix: "valid" | "chaos" | "velocity",
) {
  return ownerApi<{
    chaosKey: string;
    mix: string;
    count: number;
    funnel: Record<string, number>;
    latency: { p50: number; p95: number; max: number; avg: number };
    breaker: { threshold: number; windowMs: number; anomalies: number; tripped: boolean };
    results: Array<{ index: number; to: string; amount: number; status: string; reason?: string; latencyMs: number }>;
  }>("/api/chaos", { method: "POST", body: JSON.stringify({ walletId, count, mix }) });
}

export async function fetchTimeline(txId: string) {
  return ownerApi<{ transaction: unknown; timeline: unknown[] }>(
    `/api/transactions/${encodeURIComponent(txId)}/timeline`,
  );
}

export async function ackAlert(id: string, note: string) {
  return ownerApi<{ acknowledged: boolean; alert: unknown }>(
    `/api/outbox/${encodeURIComponent(id)}/ack`,
    { method: "POST", body: JSON.stringify({ note }) },
  );
}

export async function listSavedSearchesApi() {
  return ownerApi<{ searches: Array<{ id: string; name: string; filters: Record<string, unknown>; createdAt: number }> }>(
    "/api/searches",
  );
}

export async function saveSearchApi(name: string, filters: Record<string, unknown>) {
  return ownerApi<{ search: { id: string; name: string; filters: Record<string, unknown> } }>(
    "/api/searches",
    { method: "POST", body: JSON.stringify({ name, filters }) },
  );
}

export async function deleteSearchApi(id: string) {
  return ownerApi<{ ok: boolean }>(`/api/searches?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function mintScopedKey(input: {
  walletId: string;
  actions?: string[];
  ttlMs?: number;
}) {
  return ownerApi<{ key: string; scope: string; actions?: string[]; ttlMs?: number }>(
    "/api/keys",
    { method: "POST", body: JSON.stringify(input) },
  );
}
