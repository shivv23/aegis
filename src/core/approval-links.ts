/**
 * Decision deep links for one-tap step-up approvals. Produces a short-lived
 * `aegis-decision` JWT + the URL to /approve/[txId]?token=… that email and
 * Slack alerts can hand the owner.
 */
import { signDecisionToken } from "./keys";

export function publicBaseUrl(): string {
  return (process.env.AEGIS_PUBLIC_URL ?? "").replace(/\/$/, "") || "http://localhost:3000";
}

export async function decisionLink(
  walletId: string,
  txId: string,
  action: "approve" | "decline",
  ttlMs?: number,
): Promise<string> {
  const token = await signDecisionToken(walletId, txId, action, ttlMs);
  return `${publicBaseUrl()}/approve/${encodeURIComponent(txId)}?token=${encodeURIComponent(token)}`;
}
