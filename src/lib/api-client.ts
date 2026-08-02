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
