export type WalletStatus = "ACTIVE" | "FROZEN";

export interface SpendingWindow {
  /** UTC hour the window opens (0–23). */
  startHour: number;
  /** UTC hour the window closes (0–23). A window crossing midnight is allowed. */
  endHour: number;
}

export interface WalletPolicy {
  maxPerTx: number;
  dailyLimit: number;
  monthlyLimit: number;
  velocityLimitPerMin: number;
  allowlist: string[];
  /** Optional: only these UTC hours may spend. Empty/undefined = always allowed. */
  spendingWindows?: SpendingWindow[];
  /** Optional: allowed agent regions (e.g. "us-east", "eu-west"). Empty = unrestricted. */
  regionAllowlist?: string[];
}

export interface Wallet {
  id: string;
  name: string;
  ownerDid: string;
  status: WalletStatus;
  balance: number;
  policy: WalletPolicy;
  createdAt: number;
  /** Multi-tenant: owning organization, when scoped. */
  orgId?: string;
  /** Settlement rail this wallet prefers (A2); falls back to AEGIS_RAIL env. */
  preferredRail?: string;
  /** D4: which level (org/team/wallet) supplied each effective policy field. */
  effectiveSources?: Record<string, string>;
}

export interface Organization {
  id: string;
  name: string;
  createdAt: number;
  /** Org-level default policy (D4): inherited by every team and wallet below. */
  policy?: WalletPolicy;
}

export type CounterpartyStatus = "ACTIVE" | "FLAGGED" | "BLOCKED";

export interface Counterparty {
  id: string;
  name: string;
  address: string;
  orgId?: string;
  status: CounterpartyStatus;
  flags: string[];
  totalPaid: number;
  totalTx: number;
  createdAt: number;
}

export interface BudgetGroup {
  id: string;
  orgId?: string;
  name: string;
  monthlyLimit: number;
  walletIds: string[];
  createdAt: number;
  /** Team-level policy (D4): caps inherited org defaults; wallet overrides tighten. */
  policy?: WalletPolicy;
}

export type EscrowStatus = "HELD" | "RELEASED" | "REFUNDED" | "EXPIRED";

export interface Escrow {
  id: string;
  walletId: string;
  from: string;
  to: string;
  amount: number;
  condition: string;
  status: EscrowStatus;
  createdAt: number;
  heldUntil?: number;
  releasedAt?: number;
  refundedAt?: number;
}

export interface UsageRecord {
  id: string;
  walletId: string;
  orgId?: string;
  txId: string;
  amount: number;
  fee: number;
  rail: string;
  createdAt: number;
}

export interface InvoiceLine {
  rail: string;
  amountUsd: number;
  feeUsd: number;
}

export interface Invoice {
  id: string;
  walletId: string;
  periodStart: number;
  periodEnd: number;
  status: "draft" | "finalized";
  totalUsd: number;
  totalFeeUsd: number;
  createdAt: number;
  lines: InvoiceLine[];
}

export interface KeyAcl {
  scope: Scope;
  role: string;
  walletId: string;
  orgId?: string;
  /** Optional per-key ACL actions granted beyond the role default. */
  actions?: string[];
}

export type CurrencyCode = "USD" | "USDC" | "EUR" | "INR" | "ETH";

export interface CurrencyMeta {
  code: CurrencyCode;
  symbol: string;
  /** USD notional exchange rate used for multi-currency display. */
  usdRate: number;
  decimals: number;
}

export type TxStatus =
  | "PENDING"
  | "SETTLED"
  | "BLOCKED"
  | "REVOKED"
  | "STEP_UP_REQUIRED";

/** What kind of money movement a ledger row is. */
export type TxKind = "transfer" | "deposit" | "withdrawal";

export type RejectionReason =
  | "WALLET_FROZEN"
  | "LIMIT_EXCEEDED"
  | "NOT_ALLOWLISTED"
  | "VELOCITY_EXCEEDED"
  | "INSUFFICIENT_FUNDS"
  | "IN_FLIGHT_REVOKED"
  | "INVALID_SIGNATURE"
  | "REQUEST_EXPIRED"
  | "RISK_REJECTED"
  | "STEP_UP_DECLINED"
  | "STEP_UP_EXPIRED"
  | "RAIL_FAILED"
  | "OUTSIDE_SPENDING_WINDOW"
  | "REGION_BLOCKED"
  | "COUNTERPARTY_BLOCKED"
  | "GROUP_LIMIT_EXCEEDED"
  | "ORGANIZATION_FROZEN"
  | "REPUTATION_BLOCKED"
  | "SANCTIONED";

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
  stepUpScore?: number;
  externalRef?: string;
  rail?: string;
  /** DEPOSIT/WITHDRAWAL are funding movements; default is "transfer". */
  kind?: TxKind;
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

export type Scope = "agent" | "owner" | "auditor";

export interface ScopedKeyClaims {
  walletId: string;
  scope: Scope;
  role: string;
  /** Optional signer identity for multi-sig owner key issuance. */
  keyId?: string;
  /** Optional org scope: this key can only manage wallets in this org. */
  orgId?: string;
  /** Optional per-key action families (e.g. "freeze", "policy", "audit").
   *  A key WITHOUT actions is unrestricted for its scope; a key WITH
   *  actions can only perform those actions. */
  actions?: string[];
  /** Issued-at + TTL: minted keys carry an absolute exp in the JWT. */
  ttlMs?: number;
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
  expiresAt?: number;
  revokedAt?: number;
  lastUsedAt?: number;
  acl?: KeyAcl;
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
  /** Threshold/budget alerts can be acknowledged (who + note), audited. */
  ackedAt?: number;
  ackedBy?: string;
  ackNote?: string;
}

export interface LedgerProof {
  intact: boolean;
  rows: number;
  checked: number;
  brokenAt?: { seq: number; table: string; id: string };
  headHash: string;
}

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface RiskFactor {
  name: string;
  points: number;
  reason: string;
}

export interface RiskVerdict {
  score: number;
  level: RiskLevel;
  factors: RiskFactor[];
}

export type SignerRole = "admin" | "ops" | "treasury";

export interface Signer {
  id: string;
  name: string;
  role: SignerRole;
  enabled: boolean;
  createdAt: number;
}

export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";

export type ApprovalOperation = "MINT_OWNER_KEY" | "POLICY_CHANGE";

export interface Approval {
  id: string;
  operation: ApprovalOperation;
  walletId: string;
  label: string;
  proposer: string;
  required: number;
  approvers: string[];
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number;
  keyMinted: boolean;
  /** Opaque payload (e.g. a policy-version id for POLICY_CHANGE). */
  payload?: string;
}

export interface WebhookEndpoint {
  id: string;
  orgId?: string;
  url: string;
  secret: string;
  eventTypes: string[];
  active: boolean;
  createdAt: number;
}

export type WebhookDeliveryStatus = "PENDING" | "DELIVERED" | "FAILED";

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  eventType: string;
  payload: string;
  status: WebhookDeliveryStatus;
  httpStatus?: number;
  attemptedAt: number;
  deliveredAt?: number;
}

/**
 * A recurring transfer schedule. Each due run is re-evaluated by the guard
 * at execution time — a policy tightened yesterday blocks today's run.
 */
export interface RecurringSchedule {
  id: string;
  walletId: string;
  to: string;
  amount: number;
  purpose: string;
  /** Repeat every N hours from creation (cron-lite). */
  everyHours: number;
  /** Optional daily UTC hour (0-23); when set the schedule fires once/day. */
  dailyHour?: number;
  nextRunAt: number;
  createdAt: number;
  active: boolean;
  /** Nonce prefix so each run is a fresh, nonce-unique ledger row. */
  lastRunAt?: number;
  runCount: number;
}

/** A FIDO2/WebAuthn authenticator registered against an owner account. */
export interface WebauthnCredential {
  id: string;
  owner: string;
  name: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports?: string;
  createdAt: number;
}
