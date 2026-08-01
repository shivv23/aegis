export type WalletStatus = "ACTIVE" | "FROZEN";

export interface WalletPolicy {
  maxPerTx: number;
  dailyLimit: number;
  monthlyLimit: number;
  velocityLimitPerMin: number;
  allowlist: string[];
}

export interface Wallet {
  id: string;
  name: string;
  ownerDid: string;
  status: WalletStatus;
  balance: number;
  policy: WalletPolicy;
  createdAt: number;
}

export type TxStatus = "PENDING" | "SETTLED" | "BLOCKED" | "REVOKED";

export type RejectionReason =
  | "WALLET_FROZEN"
  | "LIMIT_EXCEEDED"
  | "NOT_ALLOWLISTED"
  | "VELOCITY_EXCEEDED"
  | "INSUFFICIENT_FUNDS"
  | "IN_FLIGHT_REVOKED"
  | "INVALID_SIGNATURE"
  | "REQUEST_EXPIRED";

export interface Transaction {
  id: string;
  walletId: string;
  from: string;
  to: string;
  amount: number;
  purpose: string;
  status: TxStatus;
  rejectionReason?: RejectionReason;
  requestedAt: number;
  pendingUntil?: number;
  settledAt?: number;
  blockedAt?: number;
  revokedAt?: number;
  nonce: string;
}

export type AuditActor = "agent" | "owner" | "system";

export interface AuditLogEntry {
  id: string;
  walletId: string;
  actor: AuditActor;
  action: string;
  details: string;
  timestamp: number;
}

export type Scope = "agent" | "owner";

export interface ScopedKeyClaims {
  walletId: string;
  scope: Scope;
  role: string;
}

export interface TransferRequest {
  to: string;
  amount: number;
  purpose?: string;
  nonce: string;
}

/**
 * A transfer the agent authorizes with its Ed25519 keypair instead of a
 * bearer secret. The rail verifies the signature over the canonical message
 * before the guard runs — the agent IS its key, and a stolen token is
 * useless without the private key.
 */
export interface SignedTransferRequest {
  walletId: string;
  to: string;
  amount: number;
  purpose: string;
  nonce: string;
  requestedAt: number;
}

export interface AgentKeyRecord {
  walletId: string;
  publicKey: string;
  label: string;
  createdAt: number;
  revokedAt?: number;
}

export type PolicyVersionStatus = "PENDING" | "ACTIVE" | "SUPERSEDED";

export interface PolicyVersion {
  id: string;
  walletId: string;
  policy: WalletPolicy;
  policyHash: string;
  createdBy: string;
  effectiveAt: number;
  createdAt: number;
  status: PolicyVersionStatus;
}

export interface OutboxEntry {
  id: string;
  walletId: string;
  eventType: string;
  payload: string;
  createdAt: number;
  deliveredAt?: number;
  attemptCount: number;
}

export interface LedgerProof {
  intact: boolean;
  rows: number;
  checked: number;
  brokenAt?: { seq: number; table: string; id: string };
  headHash: string;
}
