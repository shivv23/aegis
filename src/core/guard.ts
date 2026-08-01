import type { RejectionReason, Transaction, Wallet } from "./types";

export interface GuardContext {
  spentLast24h: number;
  spentLast30d: number;
  txCountLastMin: number;
}

export interface GuardResult {
  allowed: boolean;
  reason?: RejectionReason;
  details?: string;
}

export const ok = (): GuardResult => ({ allowed: true });

export const deny = (
  reason: RejectionReason,
  details: string,
): GuardResult => ({ allowed: false, reason, details });

export function checkFreeze(wallet: Wallet): GuardResult {
  if (wallet.status === "FROZEN") {
    return deny("WALLET_FROZEN", "Wallet is frozen by owner");
  }
  return ok();
}

export function checkPerTxLimit(wallet: Wallet, amount: number): GuardResult {
  if (amount > wallet.policy.maxPerTx) {
    return deny(
      "LIMIT_EXCEEDED",
      `Amount ${amount} exceeds per-transaction limit ${wallet.policy.maxPerTx}`,
    );
  }
  return ok();
}

export function checkFunds(wallet: Wallet, amount: number): GuardResult {
  if (amount > wallet.balance) {
    return deny(
      "INSUFFICIENT_FUNDS",
      `Amount ${amount} exceeds available balance ${wallet.balance}`,
    );
  }
  return ok();
}

export function checkAllowlist(wallet: Wallet, to: string): GuardResult {
  if (!wallet.policy.allowlist.includes(to)) {
    return deny(
      "NOT_ALLOWLISTED",
      `Counterparty ${to} is not on the wallet allowlist`,
    );
  }
  return ok();
}

export function checkDailyLimit(
  wallet: Wallet,
  amount: number,
  spentLast24h: number,
): GuardResult {
  if (spentLast24h + amount > wallet.policy.dailyLimit) {
    return deny(
      "LIMIT_EXCEEDED",
      `Daily spend ${spentLast24h} + ${amount} exceeds daily limit ${wallet.policy.dailyLimit}`,
    );
  }
  return ok();
}

export function checkMonthlyLimit(
  wallet: Wallet,
  amount: number,
  spentLast30d: number,
): GuardResult {
  if (spentLast30d + amount > wallet.policy.monthlyLimit) {
    return deny(
      "LIMIT_EXCEEDED",
      `Monthly spend ${spentLast30d} + ${amount} exceeds monthly limit ${wallet.policy.monthlyLimit}`,
    );
  }
  return ok();
}

export function checkVelocity(
  wallet: Wallet,
  txCountLastMin: number,
): GuardResult {
  if (txCountLastMin >= wallet.policy.velocityLimitPerMin) {
    return deny(
      "VELOCITY_EXCEEDED",
      `Velocity limit of ${wallet.policy.velocityLimitPerMin} tx/min reached`,
    );
  }
  return ok();
}

/**
 * The full guard chain. Runs every policy check in order and returns
 * the first violation. This is the single choke point through which all
 * money movement must pass. It is pure and deterministic by design.
 */
export function runGuard(
  wallet: Wallet,
  amount: number,
  to: string,
  context: GuardContext,
): GuardResult {
  const checks: GuardResult[] = [
    checkFreeze(wallet),
    checkPerTxLimit(wallet, amount),
    checkAllowlist(wallet, to),
    checkFunds(wallet, amount),
    checkDailyLimit(wallet, amount, context.spentLast24h),
    checkMonthlyLimit(wallet, amount, context.spentLast30d),
    checkVelocity(wallet, context.txCountLastMin),
  ];

  for (const result of checks) {
    if (!result.allowed) return result;
  }
  return ok();
}

export function spendContext(
  walletId: string,
  now: number,
  history: Transaction[],
): GuardContext {
  const dayMs = 24 * 60 * 60 * 1000;
  const monthMs = 30 * dayMs;
  const minuteMs = 60 * 1000;

  /**
   * Count both SETTLED and in-flight PENDING transfers. Pending amounts are
   * reserved on approval (not settlement) — otherwise a rapid split attack
   * could blow past the daily cap before anything settles.
   */
  const relevant = history.filter(
    (t) =>
      t.walletId === walletId &&
      (t.status === "SETTLED" || t.status === "PENDING"),
  );

  const when = (t: Transaction) => (t.status === "SETTLED" ? t.settledAt! : t.requestedAt);

  const spentLast24h = relevant
    .filter((t) => now - when(t) < dayMs)
    .reduce((sum, t) => sum + t.amount, 0);

  const spentLast30d = relevant
    .filter((t) => now - when(t) < monthMs)
    .reduce((sum, t) => sum + t.amount, 0);

  const txCountLastMin = relevant.filter(
    (t) => now - when(t) < minuteMs,
  ).length;

  return { spentLast24h, spentLast30d, txCountLastMin };
}
