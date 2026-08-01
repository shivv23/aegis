import type { RejectionReason, Transaction, Wallet } from "./types";

export interface GuardContext {
  spentLast24h: number;
  spentLast30d: number;
  txCountLastMin: number;
  /** Timestamp used for the spending-window check. */
  now: number;
  /** Optional region claim from the request (e.g. "us-east") for geo policy. */
  region?: string;
  /** Optional spend already consumed by the wallet's budget group this period. */
  groupSpent?: number;
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
 * Time constraint: when spendingWindows are configured, the request's UTC hour
 * must fall inside at least one window. A window that wraps midnight
 * (startHour > endHour) is treated as crossing into the next day.
 */
export function checkSpendingWindow(
  wallet: Wallet,
  now: number,
): GuardResult {
  const windows = wallet.policy.spendingWindows;
  if (!windows || windows.length === 0) return ok();

  const hour = new Date(now).getUTCHours();
  const inside = windows.some((w) => {
    if (w.startHour <= w.endHour) return hour >= w.startHour && hour <= w.endHour;
    return hour >= w.startHour || hour <= w.endHour;
  });
  if (!inside) {
    const desc = windows.map((w) => `${w.startHour}:00–${w.endHour}:00Z`).join(", ");
    return deny(
      "OUTSIDE_SPENDING_WINDOW",
      `Current UTC hour ${hour} is outside allowed spending window(s): ${desc}`,
    );
  }
  return ok();
}

/** Geo constraint: a region claim must be in the policy's regionAllowlist. */
export function checkRegion(
  wallet: Wallet,
  region: string | undefined,
): GuardResult {
  const allowed = wallet.policy.regionAllowlist;
  if (!allowed || allowed.length === 0) return ok();
  if (!region) {
    return deny("REGION_BLOCKED", "Region claim required by policy region allowlist");
  }
  if (!allowed.includes(region)) {
    return deny(
      "REGION_BLOCKED",
      `Region '${region}' is not in the policy allowlist`,
    );
  }
  return ok();
}

/** Counterparty reputation: blocked counterparties never clear the guard. */
export function checkCounterparty(
  status: string | undefined,
  to: string,
): GuardResult {
  if (status === "BLOCKED") {
    return deny("COUNTERPARTY_BLOCKED", `Counterparty ${to} is blocked by the registry`);
  }
  return ok();
}

/** Budget group: cross-wallet spend is capped at the group level. */
export function checkGroupBudget(
  groupLimit: number | undefined,
  groupSpent: number | undefined,
  amount: number,
): GuardResult {
  if (groupLimit !== undefined && groupSpent !== undefined) {
    if (groupSpent + amount > groupLimit) {
      return deny(
        "GROUP_LIMIT_EXCEEDED",
        `Budget group spend ${groupSpent} + ${amount} exceeds group limit ${groupLimit}`,
      );
    }
  }
  return ok();
}

/**
 * Reputation gate (D5): a wallet whose behavioural track record is broken
 * (score below 15) is blocked from moving money until its reliability
 * improves. Optional — only enforced when the caller supplies a score, so
 * purely-local policy checks never depend on history.
 */
export function checkReputation(
  reputation: number | undefined,
): GuardResult {
  if (reputation !== undefined && reputation < 15) {
    return deny(
      "REPUTATION_BLOCKED",
      `Agent reputation ${reputation}/100 is below the 15/100 reliability floor`,
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
  extra?: {
    counterpartyStatus?: string;
    groupLimit?: number;
    /** Agent reputation (0–100, D5). Only enforced when explicitly provided. */
    reputation?: number;
  },
): GuardResult {
  const checks: GuardResult[] = [
    checkFreeze(wallet),
    checkPerTxLimit(wallet, amount),
    checkAllowlist(wallet, to),
    checkSpendingWindow(wallet, context.now ?? Date.now()),
    checkRegion(wallet, context.region),
    checkCounterparty(extra?.counterpartyStatus, to),
    checkReputation(extra?.reputation),
    checkFunds(wallet, amount),
    checkDailyLimit(wallet, amount, context.spentLast24h),
    checkMonthlyLimit(wallet, amount, context.spentLast30d),
    checkGroupBudget(extra?.groupLimit, context.groupSpent, amount),
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

  return { spentLast24h, spentLast30d, txCountLastMin, now };
}
