"use client";

import type { Wallet } from "@/core/types";

const OWNER_KEY = "aegis-owner-key";

export interface Bootstrap {
  ownerKey: string;
  seedWalletId: string;
  seeded: boolean;
}

export async function getBootstrap(): Promise<Bootstrap> {
  const res = await fetch("/api/bootstrap");
  if (!res.ok) throw new Error("Bootstrap failed");
  return res.json();
}

export async function ensureOwnerKey(): Promise<string> {
  const existing = localStorage.getItem(OWNER_KEY);
  if (existing) return existing;
  const b = await getBootstrap();
  localStorage.setItem(OWNER_KEY, b.ownerKey);
  return b.ownerKey;
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
