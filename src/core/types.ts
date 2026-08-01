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
  | "INVALID_SIGNATURE";

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
