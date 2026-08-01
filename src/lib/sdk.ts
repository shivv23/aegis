/**
 * AEGIS SDK — the only thing an agent should ever hold.
 *
 * ```ts
 * import { Aegis } from "aegis-sdk";           // or relative import
 *
 * const aegis = new Aegis({
 *   baseUrl: "https://aegis-shivv23s-projects.vercel.app",
 *   walletId: "wallet-tradingbot-42",
 *   privateKey: process.env.AGENT_PRIVATE_KEY, // Ed25519 pkcs8 (base64url)
 * });
 *
 * const r = await aegis.transfer({ to: "compute:0xCAFE0001", amount: 30, purpose: "GPU burst" });
 * // r = { ok: true, status: 201, tx: { id, status: "PENDING", ... } }
 * ```
 *
 * With a `privateKey`, every transfer is signed (Ed25519) — the agent IS its
 * keypair. With only an `apiKey`, requests use the legacy bearer JWT.
 *
 * This module is Node-first (agent code runs in Node); the browser can use
 * the JWT mode via the same class.
 */

import { createPrivateKey, randomUUID, sign } from "node:crypto";

export interface AegisOptions {
  /** API base, e.g. "https://aegis.example.com". Default: same origin. */
  baseUrl?: string;
  /** Bearer owner/agent JWT (legacy auth, or owner control-plane). */
  apiKey?: string;
  /** Wallet id for the signed-agent identity (required with privateKey). */
  walletId?: string;
  /** Ed25519 private key, PKCS8 DER, base64url — the agent's identity. */
  privateKey?: string;
}

export interface AegisResponse<T = Record<string, unknown>> {
  ok: boolean;
  status: number;
  body: T;
}

export interface AegisTransferInput {
  to: string;
  amount: number;
  purpose?: string;
}

const CANONICAL_TAG = "aegis-agent-transfer";

export class Aegis {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly walletId?: string;
  readonly privateKey?: string;

  constructor(opts: AegisOptions) {
    this.baseUrl = (opts.baseUrl ?? "").replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.walletId = opts.walletId;
    this.privateKey = opts.privateKey;
    if (!this.apiKey && !this.privateKey) {
      throw new Error("Aegis: provide an apiKey or a privateKey");
    }
    if (this.privateKey && !this.walletId) {
      throw new Error("Aegis: walletId is required when using privateKey");
    }
  }

  /** Canonical message the agent signs — must match the rail's verifier. */
  static canonicalMessage(input: AegisTransferInput & { walletId: string; nonce: string; requestedAt: number }): string {
    return [
      CANONICAL_TAG,
      "v1",
      input.walletId,
      input.nonce,
      input.requestedAt,
      input.to,
      input.amount,
      input.purpose ?? "agent-transfer",
    ].join("|");
  }

  /**
   * The single action an agent can take: request a transfer.
   * The guard decides; the agent cannot read, weaken, or bypass it.
   */
  async transfer(input: AegisTransferInput): Promise<AegisResponse> {
    const nonce = randomUUID();
    const requestedAt = Date.now();
    const body = {
      to: input.to,
      amount: input.amount,
      purpose: input.purpose ?? "agent-transfer",
      nonce,
    };
    const headers: Record<string, string> = { "Content-Type": "application/json" };

    if (this.privateKey) {
      const message = Aegis.canonicalMessage({ ...input, walletId: this.walletId!, nonce, requestedAt });
      headers["x-aegis-wallet"] = this.walletId!;
      headers["x-aegis-timestamp"] = String(requestedAt);
      headers["x-aegis-signature"] = this.sign(message);
    } else {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    return this.request("/api/rail/transfer", { method: "POST", headers, body });
  }

  /** GET /api/rail/health — verify scoped identity. */
  health(): Promise<AegisResponse> {
    return this.request("/api/rail/health");
  }

  /** POST /api/keys/mint — mint an Ed25519 agent keypair (owner key). */
  mintAgentKey(walletId: string, label = "agent"): Promise<AegisResponse> {
    return this.request("/api/keys/mint", { method: "POST", body: { walletId, label } });
  }

  /** GET /api/keys?walletId= — mint scoped owner/agent JWT keys (master key). */
  scopedKeys(walletId: string): Promise<AegisResponse> {
    return this.request(`/api/keys?walletId=${encodeURIComponent(walletId)}`);
  }

  // ---- owner control plane -------------------------------------------------

  createWallet(input: {
    name: string;
    ownerDid: string;
    balance: number;
    policy: {
      maxPerTx: number;
      dailyLimit: number;
      monthlyLimit: number;
      velocityLimitPerMin: number;
      allowlist: string[];
    };
  }): Promise<AegisResponse> {
    return this.request("/api/wallet", { method: "POST", body: input });
  }

  listWallets(): Promise<AegisResponse> {
    return this.request("/api/wallet");
  }

  getWallet(id: string): Promise<AegisResponse> {
    return this.request(`/api/wallet/${encodeURIComponent(id)}`);
  }

  patchPolicy(id: string, policy: Record<string, unknown>): Promise<AegisResponse> {
    return this.request(`/api/wallet/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { policy },
    });
  }

  freeze(id: string): Promise<AegisResponse> {
    return this.request(`/api/wallet/${encodeURIComponent(id)}/freeze`, { method: "POST" });
  }

  unfreeze(id: string): Promise<AegisResponse> {
    return this.request(`/api/wallet/${encodeURIComponent(id)}/unfreeze`, { method: "POST" });
  }

  listTransactions(): Promise<AegisResponse> {
    return this.request("/api/transactions");
  }

  revoke(txId: string): Promise<AegisResponse> {
    return this.request(`/api/transactions/${encodeURIComponent(txId)}/revoke`, { method: "POST" });
  }

  stepUp(txId: string, decision: "approve" | "decline"): Promise<AegisResponse> {
    return this.request(`/api/transactions/${encodeURIComponent(txId)}/stepup`, {
      method: "POST",
      body: { decision },
    });
  }

  // ---- systems --------------------------------------------------------------

  verifyLedger(): Promise<AegisResponse> {
    return this.request("/api/ledger/verify");
  }

  audit(): Promise<AegisResponse> {
    return this.request("/api/audit");
  }

  outbox(): Promise<AegisResponse> {
    return this.request("/api/outbox");
  }

  rails(): Promise<AegisResponse> {
    return this.request("/api/rails");
  }

  guardian(): Promise<AegisResponse> {
    return this.request("/api/guardian");
  }

  breaker(): Promise<AegisResponse> {
    return this.request("/api/breaker");
  }

  simulate(input: Record<string, unknown>): Promise<AegisResponse> {
    return this.request("/api/simulate", { method: "POST", body: input });
  }

  // ---- counterparties ----------------------------------------------------------

  listCounterparties(): Promise<AegisResponse> {
    return this.request("/api/counterparties");
  }

  upsertCounterparty(input: {
    name: string;
    address: string;
    status?: "ACTIVE" | "FLAGGED" | "BLOCKED";
    flags?: string[];
    notes?: string;
  }): Promise<AegisResponse> {
    return this.request("/api/counterparties", { method: "POST", body: input });
  }

  // ---- budget groups ------------------------------------------------------------

  listBudgetGroups(walletId?: string): Promise<AegisResponse> {
    return this.request(
      walletId ? `/api/budget-groups?walletId=${encodeURIComponent(walletId)}` : "/api/budget-groups",
    );
  }

  createBudgetGroup(input: { name: string; monthlyLimit: number; walletIds?: string[] }): Promise<AegisResponse> {
    return this.request("/api/budget-groups", { method: "POST", body: input });
  }

  // ---- escrows -------------------------------------------------------------------

  listEscrows(walletId?: string): Promise<AegisResponse> {
    return this.request(
      walletId ? `/api/escrows?walletId=${encodeURIComponent(walletId)}` : "/api/escrows",
    );
  }

  createEscrow(input: {
    walletId: string;
    to: string;
    amount: number;
    condition: string;
    expiresAt?: number;
  }): Promise<AegisResponse> {
    return this.request("/api/escrows", { method: "POST", body: input });
  }

  releaseEscrow(id: string): Promise<AegisResponse> {
    return this.request(`/api/escrows?id=${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { action: "release" },
    });
  }

  refundEscrow(id: string): Promise<AegisResponse> {
    return this.request(`/api/escrows?id=${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { action: "refund" },
    });
  }

  // ---- usage + multi-currency -----------------------------------------------------

  usage(walletId?: string): Promise<AegisResponse> {
    return this.request(walletId ? `/api/usage?walletId=${encodeURIComponent(walletId)}` : "/api/usage");
  }

  currencies(): Promise<AegisResponse> {
    return this.request("/api/currencies");
  }

  // ---- regulator export -------------------------------------------------------------

  exportAuditCsv(): Promise<AegisResponse> {
    return this.request("/api/export?kind=audit.csv");
  }

  exportAuditLogCsv(): Promise<AegisResponse> {
    return this.request("/api/export?kind=auditlog.csv");
  }

  exportAuditJson(): Promise<AegisResponse> {
    return this.request("/api/export?kind=audit.json");
  }

  sarReport(): Promise<AegisResponse> {
    return this.request("/api/export?kind=report");
  }

  // ---- key lifecycle ----------------------------------------------------------------

  listAgentKeys(walletId: string): Promise<AegisResponse> {
    return this.request(`/api/keys?walletId=${encodeURIComponent(walletId)}`);
  }

  revokeAgentKey(walletId: string, publicKey: string): Promise<AegisResponse> {
    return this.request("/api/keys/revoke", { method: "POST", body: { walletId, publicKey } });
  }

  rotateAgentKey(walletId: string, oldPublicKey: string): Promise<AegisResponse> {
    return this.request("/api/keys/rotate", { method: "POST", body: { walletId, oldPublicKey } });
  }

  // ---- multi-sig ------------------------------------------------------------

  listSigners(): Promise<AegisResponse> {
    return this.request("/api/signers");
  }

  registerSigner(input: { name: string; role: string }): Promise<AegisResponse> {
    return this.request("/api/signers", { method: "POST", body: input });
  }

  removeSigner(id: string): Promise<AegisResponse> {
    return this.request(`/api/signers/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  listApprovals(): Promise<AegisResponse> {
    return this.request("/api/approvals");
  }

  proposeApproval(input: Record<string, unknown>): Promise<AegisResponse> {
    return this.request("/api/approvals", { method: "POST", body: input });
  }

  approveApproval(id: string): Promise<AegisResponse> {
    return this.request(`/api/approvals/${encodeURIComponent(id)}/approve`, { method: "POST" });
  }

  rejectApproval(id: string): Promise<AegisResponse> {
    return this.request(`/api/approvals/${encodeURIComponent(id)}/reject`, { method: "POST" });
  }

  // ---- organizations --------------------------------------------------------

  listOrgs(): Promise<AegisResponse> {
    return this.request("/api/orgs");
  }

  createOrg(name: string): Promise<AegisResponse> {
    return this.request("/api/orgs", { method: "POST", body: { name } });
  }

  getOrg(id: string): Promise<AegisResponse> {
    return this.request(`/api/orgs/${encodeURIComponent(id)}`);
  }

  // ---- internals ------------------------------------------------------------

  private sign(message: string): string {
    const key = createPrivateKey({
      key: Buffer.from(this.privateKey!, "base64url"),
      type: "pkcs8",
      format: "der",
    });
    return sign(null, Buffer.from(message), key).toString("base64url");
  }

  private async request(path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<AegisResponse> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey && !init.headers?.["Authorization"] ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        ...(init.headers ?? {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, body };
  }
}

export default Aegis;
