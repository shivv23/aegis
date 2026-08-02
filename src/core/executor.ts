import { randomUUID, createHash } from "node:crypto";
import { checkFreeze, checkFunds, runGuard, spendContext } from "./guard";
import { screenCounterparty } from "./sanctions";
import {
  HOLD_MS,
  STEP_UP_TTL_MS,
  addAudit,
  advanceRecurringSchedule,
  agentReputation,
  consumeNonce,
  createTransaction,
  creditWallet,
  debitWallet,
  emitStructuringAlerts,
  emitThresholdAlert,
  expireStepUps,
  findTransactionByIdempotencyKey,
  getBudgetGroupForWallet,
  getCounterparty,
  groupSpendLast30d,
  isOrgFrozen,
  listRecurringSchedules,
  listTransactions,
  recordAnomaly,
  recordOutbox,
  resolveEffectiveWallet,
  settleDue,
} from "./store";
import { CRITICAL_THRESHOLD, scoreTransfer, STEP_UP_THRESHOLD } from "./risk";
import { decisionLink } from "./approval-links";
import type { TxKind } from "./types";

export interface TransferOutcome {
  status: number;
  body: unknown;
}

/**
 * The single money-movement executor. Every path — single transfer, batch
 * rows, recurring runs — funnels through here so policy, risk and sanitization
 * behave identically everywhere.
 */
export async function runTransfer(input: {
  walletId: string;
  to: string;
  amount: number;
  purpose: string;
  nonce?: string;
  now?: number;
  region?: string;
  idempotencyKey?: string;
}): Promise<TransferOutcome> {
  const {
    walletId,
    to,
    amount,
    purpose,
    nonce = randomUUID(),
    now = Date.now(),
    region,
    idempotencyKey,
  } = input;

  // Idempotent retry: a replayed key returns the original result instead of
  // double-settling. Checked before nonce consumption so a retry does not
  // burn the nonce or create a second transaction.
  if (idempotencyKey) {
    const existing = await findTransactionByIdempotencyKey(idempotencyKey);
    if (existing) {
      return { status: 200, body: { status: existing.status, replayed: true, transaction: existing } };
    }
  }

  if (!(await consumeNonce(nonce))) {
    return { status: 409, body: { error: "Replay detected: nonce already used" } };
  }

  await settleDue();
  await expireStepUps(now);
  const wallet = await resolveEffectiveWallet(walletId);
  if (!wallet) return { status: 404, body: { error: "Wallet not found" } };

  // C7 kill switch: a global or org-level kill switch freezes the whole fleet.
  const frozenReason = await isOrgFrozen(wallet.orgId);
  if (frozenReason) {
    const tx = await createTransaction({
      walletId: wallet.id,
      from: wallet.id,
      to,
      amount,
      purpose,
      status: "BLOCKED",
      rejectionReason: "ORGANIZATION_FROZEN",
      requestedAt: now,
      blockedAt: now,
      nonce,
      idempotencyKey,
    });
    await recordAnomaly(wallet.id, "TX_BLOCKED", `${amount} to ${to} blocked: kill switch active (${frozenReason})`);
    await addAudit({
      walletId: wallet.id,
      actor: "system",
      action: "TX_BLOCKED",
      details: `${amount} to ${to} blocked by kill switch: ${frozenReason}`,
    });
    return {
      status: 403,
      body: {
        status: "BLOCKED",
        reason: "ORGANIZATION_FROZEN",
        details: `Kill switch active: ${frozenReason}`,
        transaction: tx,
      },
    };
  }

  const history = await listTransactions(wallet.id);
  const context = spendContext(wallet.id, now, history);

  // Counterparty reputation + budget group + agent reputation enforcement.
  const counterparty = await getCounterparty(to);
  const group = await getBudgetGroupForWallet(wallet.id);
  const groupSpent = group ? await groupSpendLast30d(group, now) : undefined;
  const reputation = (await agentReputation(wallet.id)).score;

  const verdict = runGuard(wallet, amount, to, { ...context, region, groupSpent }, {
    counterpartyStatus: counterparty?.status,
    groupLimit: group?.monthlyLimit,
    reputation,
    sanctionsMatch: screenCounterparty({ name: counterparty?.name, address: to }),
  });

  if (!verdict.allowed) {
    const tx = await createTransaction({
      walletId: wallet.id,
      from: wallet.id,
      to,
      amount,
      purpose,
      status: "BLOCKED",
      rejectionReason: verdict.reason,
      requestedAt: now,
      blockedAt: now,
      nonce,
      idempotencyKey,
    });
    await recordAnomaly(wallet.id, "TX_BLOCKED", `${amount} to ${to} blocked: ${verdict.details}`);
    await addAudit({
      walletId: wallet.id,
      actor: "agent",
      action: "TX_BLOCKED",
      details: `${amount} to ${to} blocked by guard: ${verdict.details}`,
    });
    return {
      status: 403,
      body: {
        status: "BLOCKED",
        reason: verdict.reason,
        details: verdict.details,
        transaction: tx,
      },
    };
  }

  // Hard guard passed — now score the transfer for risk.
  const risk = scoreTransfer({ wallet, amount, to, purpose, history, now });

  if (risk.level === "CRITICAL") {
    const tx = await createTransaction({
      walletId: wallet.id,
      from: wallet.id,
      to,
      amount,
      purpose,
      status: "BLOCKED",
      rejectionReason: "RISK_REJECTED",
      requestedAt: now,
      blockedAt: now,
      nonce,
      idempotencyKey,
      stepUpScore: risk.score,
    });
    await recordAnomaly(wallet.id, "TX_BLOCKED_RISK", `Critical risk score ${risk.score} for ${amount} to ${to}`);
    return {
      status: 403,
      body: {
        status: "BLOCKED",
        reason: "RISK_REJECTED",
        details: `Critical risk score ${risk.score} (threshold ${CRITICAL_THRESHOLD})`,
        score: risk.score,
        factors: risk.factors,
        transaction: tx,
      },
    };
  }

  if (risk.level === "HIGH") {
    const stepUpUntil = now + STEP_UP_TTL_MS;
    const tx = await createTransaction({
      walletId: wallet.id,
      from: wallet.id,
      to,
      amount,
      purpose,
      status: "STEP_UP_REQUIRED",
      requestedAt: now,
      pendingUntil: stepUpUntil,
      nonce,
      idempotencyKey,
      stepUpScore: risk.score,
    });
    await addAudit({
      walletId: wallet.id,
      actor: "system",
      action: "STEP_UP_REQUIRED",
      details: `Risk score ${risk.score} (threshold ${STEP_UP_THRESHOLD}) — owner approval required for ${amount} to ${to}`,
    });
    await recordOutbox(wallet.id, "STEP_UP_REQUIRED", {
      txId: tx.id,
      amount,
      to,
      score: risk.score,
      factors: risk.factors,
      approveLink: await decisionLink(wallet.id, tx.id, "approve"),
      declineLink: await decisionLink(wallet.id, tx.id, "decline"),
    });
    return {
      status: 202,
      body: {
        status: "STEP_UP_REQUIRED",
        message: `Risk score ${risk.score} requires owner approval. Expires in ${STEP_UP_TTL_MS}ms.`,
        score: risk.score,
        threshold: STEP_UP_THRESHOLD,
        factors: risk.factors,
        expiresInMs: STEP_UP_TTL_MS,
        approveLink: await decisionLink(wallet.id, tx.id, "approve"),
        declineLink: await decisionLink(wallet.id, tx.id, "decline"),
        transaction: tx,
      },
    };
  }

  const pendingUntil = now + HOLD_MS;
  const tx = await createTransaction({
    walletId: wallet.id,
    from: wallet.id,
    to,
    amount,
    purpose,
    status: "PENDING",
    requestedAt: now,
    pendingUntil,
    nonce,
    stepUpScore: risk.score,
    idempotencyKey,
    kind: "transfer",
  });
  await addAudit({
    walletId: wallet.id,
    actor: "agent",
    action: "TX_REQUESTED",
    details: `${amount} to ${to} requested, holding until settlement (in-flight window)`,
  });

  // Proactive ops alerts: budget thresholds + structuring are warnings, not
  // blocks — emit them now that this transfer is in flight.
  await checkAndEmitWarnings(wallet.id, now);

  return {
    status: 201,
    body: {
      status: "PENDING",
      message: `Transfer in flight. Will settle in ${HOLD_MS}ms unless frozen or revoked.`,
      holdsForMs: HOLD_MS,
      score: risk.score,
      transaction: tx,
    },
  };
}

/**
 * Budget-threshold (80%/100%) and structuring alerts. Fired on the ops feed
 * after money moves; both are deduped per day so they stay readable.
 */
async function checkAndEmitWarnings(walletId: string, now: number): Promise<void> {
  const [wallet, history] = await Promise.all([
    resolveEffectiveWallet(walletId),
    listTransactions(walletId),
  ]);
  if (!wallet) return;

  const context = spendContext(walletId, now, history);
  if (context.spentLast24h / wallet.policy.dailyLimit >= 0.8) {
    await emitThresholdAlert({
      walletId,
      limitKind: "daily",
      threshold: context.spentLast24h >= wallet.policy.dailyLimit ? "p100" : "p80",
      limit: wallet.policy.dailyLimit,
      spent: context.spentLast24h,
    });
  }
  if (context.spentLast30d / wallet.policy.monthlyLimit >= 0.8) {
    await emitThresholdAlert({
      walletId,
      limitKind: "monthly",
      threshold: context.spentLast30d >= wallet.policy.monthlyLimit ? "p100" : "p80",
      limit: wallet.policy.monthlyLimit,
      spent: context.spentLast30d,
    });
  }
  const group = await getBudgetGroupForWallet(walletId);
  if (group) {
    const spent = await groupSpendLast30d(group, now);
    if (spent / group.monthlyLimit >= 0.8) {
      await emitThresholdAlert({
        walletId,
        limitKind: "group",
        threshold: spent >= group.monthlyLimit ? "p100" : "p80",
        limit: group.monthlyLimit,
        spent,
      });
    }
  }
  await emitStructuringAlerts(history, now);
}

/**
 * Simulated funding lifecycle — money in (deposit) then money out
 * (withdrawal). Both land in the same hash-chained ledger with a bank-style
 * reference and stay explicitly `simulated` — no real money moves.
 */
export async function runDeposit(input: {
  walletId: string;
  amount: number;
  method?: string;
  idempotencyKey?: string;
}): Promise<TransferOutcome> {
  const { walletId, amount, idempotencyKey } = input;
  const method = input.method ?? "wire";
  const now = Date.now();

  if (idempotencyKey) {
    const existing = await findTransactionByIdempotencyKey(idempotencyKey);
    if (existing) return { status: 200, body: { status: existing.status, replayed: true, transaction: existing } };
  }

  const wallet = await resolveEffectiveWallet(walletId);
  if (!wallet) return { status: 404, body: { error: "Wallet not found" } };

  const ref = `ach://credit/${createFundingRef(wallet.id, now)}`;
  const tx = await createTransaction({
    walletId: wallet.id,
    from: "bank:simulated",
    to: wallet.id,
    amount,
    purpose: `${method}-deposit`,
    status: "SETTLED",
    requestedAt: now,
    settledAt: now,
    nonce: randomUUID(),
    idempotencyKey,
    rail: "ach-lite",
    externalRef: ref,
    kind: "deposit",
  });
  const updated = await creditWallet(wallet.id, amount);
  await addAudit({
    walletId: wallet.id,
    actor: "owner",
    action: "DEPOSIT_SETTLED",
    details: `${amount} deposited via simulated ${method} rail (${ref})`,
  });
  await recordOutbox(wallet.id, "DEPOSIT", { txId: tx.id, amount, ref, simulated: true });
  return {
    status: 201,
    body: {
      status: "SETTLED",
      simulated: true,
      message: `Simulated ${method} deposit settled instantly. No real money moved.`,
      transaction: tx,
      externalRef: ref,
      newBalance: updated?.balance,
    },
  };
}

export async function runWithdrawal(input: {
  walletId: string;
  amount: number;
  destination: string;
  idempotencyKey?: string;
}): Promise<TransferOutcome> {
  const { walletId, amount, destination, idempotencyKey } = input;
  const now = Date.now();

  if (idempotencyKey) {
    const existing = await findTransactionByIdempotencyKey(idempotencyKey);
    if (existing) return { status: 200, body: { status: existing.status, replayed: true, transaction: existing } };
  }

  const wallet = await resolveEffectiveWallet(walletId);
  if (!wallet) return { status: 404, body: { error: "Wallet not found" } };

  const guardChecks = [checkFreeze(wallet), checkFunds(wallet, amount)];
  for (const c of guardChecks) {
    if (!c.allowed) {
      return { status: 403, body: { status: "BLOCKED", reason: c.reason, details: c.details } };
    }
  }

  const ref = `ach://debit/${createFundingRef(wallet.id, now)}`;
  const tx = await createTransaction({
    walletId: wallet.id,
    from: wallet.id,
    to: `bank:${destination}`,
    amount,
    purpose: "withdrawal",
    status: "SETTLED",
    requestedAt: now,
    settledAt: now,
    nonce: randomUUID(),
    idempotencyKey,
    rail: "ach-lite",
    externalRef: ref,
    kind: "withdrawal",
  });
  const updated = await debitWallet(wallet.id, amount);
  await addAudit({
    walletId: wallet.id,
    actor: "owner",
    action: "WITHDRAWAL_SETTLED",
    details: `${amount} withdrawn to ${destination} via simulated ACH rail (${ref})`,
  });
  await recordOutbox(wallet.id, "WITHDRAWAL", { txId: tx.id, amount, ref, destination, simulated: true });
  return {
    status: 201,
    body: {
      status: "SETTLED",
      simulated: true,
      message: `Simulated withdrawal to ${destination} settled instantly. No real money moved.`,
      transaction: tx,
      externalRef: ref,
      newBalance: updated?.balance,
    },
  };
}

function createFundingRef(walletId: string, now: number): string {
  return createHash("sha256")
    .update(`${walletId}:${now}:${randomUUID()}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Runs every due recurring schedule through the guard at execution time.
 * A policy tightened since the schedule was created blocks today's run.
 */
export async function runRecurringDue(now = Date.now()) {
  const schedules = (await listRecurringSchedules()).filter(
    (s) => s.active && s.nextRunAt <= now,
  );

  const results: Array<{ scheduleId: string; to: string; amount: number; status: string; reason?: string }> = [];
  for (const schedule of schedules) {
    const outcome = await runTransfer({
      walletId: schedule.walletId,
      to: schedule.to,
      amount: schedule.amount,
      purpose: schedule.purpose,
      now,
    });
    const body = outcome.body as { status?: string; reason?: string };
    results.push({
      scheduleId: schedule.id,
      to: schedule.to,
      amount: schedule.amount,
      status: body.status ?? "ERROR",
      reason: body.reason,
    });
    // Advance even when blocked: the guard decided, don't retry the same tick.
    await advanceRecurringSchedule(schedule.id, now);
  }
  return { ran: results.length, results };
}

export type { TxKind };
