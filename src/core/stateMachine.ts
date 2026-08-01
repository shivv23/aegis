import type { TxStatus } from "./types";

const VALID_TRANSITIONS: Record<TxStatus, TxStatus[]> = {
  PENDING: ["SETTLED", "BLOCKED", "REVOKED"],
  SETTLED: [],
  BLOCKED: [],
  REVOKED: [],
};

export function canTransition(from: TxStatus, to: TxStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TxStatus, to: TxStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(
      `Illegal transaction state transition: ${from} -> ${to}`,
    );
  }
}
