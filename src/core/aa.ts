/**
 * ERC-4337 smart-account gate (D3): validates UserOperations against the
 * AEGIS wallet policy exactly like the on-chain guard, plus a deterministic
 * packUserOp and a minimal ABI-ish encoder/decoder for execTransaction callData.
 */

import { checkAllowlist, checkFreeze, checkFunds, checkPerTxLimit } from "./guard";
import type { GuardResult } from "./guard";
import type { Wallet, WalletPolicy } from "./types";

export interface UserOperation {
  sender: string;
  nonce: string;
  initCode: string;
  callData: string;
  callGasLimit: string;
  verificationGasLimit: string;
  preVerificationGas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  paymasterAndData: string;
  signature: string;
}

export interface ValidationResult {
  valid: boolean;
  reason?: string;
  walletStatus?: string;
  effectivePolicy?: WalletPolicy;
}

export interface PendingVerdict {
  allowed: boolean;
  reason?: string;
}

export interface DecodedCall {
  selector: string;
  to: string;
  amount: number;
  data: string;
}

const EXEC_TRANSACTION_SELECTOR = "0x6a761202";
const KNOWN_SELECTORS: Record<string, string> = {
  execTransaction: EXEC_TRANSACTION_SELECTOR,
};

const PACK_ORDER: Array<keyof UserOperation> = [
  "sender",
  "nonce",
  "initCode",
  "callData",
  "callGasLimit",
  "verificationGasLimit",
  "preVerificationGas",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
  "paymasterAndData",
];

function strip0x(value: string): string {
  return value.startsWith("0x") ? value.slice(2) : value;
}

function normalizeSelector(selector: string): string {
  const hex = strip0x(selector);
  if (/^[0-9a-fA-F]{8}$/.test(hex)) return "0x" + hex.toLowerCase();
  const known = KNOWN_SELECTORS[selector];
  if (known) return known;
  throw new Error(`Unknown call selector: ${selector}`);
}

function hexUint(value: unknown): string {
  let big: bigint;
  if (typeof value === "bigint") {
    big = value;
  } else if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error("uint256 must be a non-negative integer");
    }
    big = BigInt(value);
  } else if (typeof value === "string") {
    const hex = strip0x(value);
    if (!/^[0-9a-fA-F]+$/.test(hex)) throw new Error("uint256 string must be hex");
    big = BigInt("0x" + hex);
  } else {
    throw new Error("uint256 must be number, bigint, or hex string");
  }
  return big.toString(16).padStart(64, "0");
}

function hexAddress(value: unknown): string {
  if (typeof value !== "string") throw new Error("address must be a string");
  const hex = strip0x(value);
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length > 40) {
    throw new Error("invalid address");
  }
  return hex.toLowerCase().padStart(40, "0");
}

function hexBytes(value: unknown): string {
  if (typeof value !== "string") throw new Error("bytes must be a string");
  const hex = strip0x(value);
  if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Error("invalid bytes");
  return hex.toLowerCase();
}

export function encodeCallData(selector: string, args: unknown[]): string {
  const parts: string[] = [strip0x(normalizeSelector(selector))];
  args.forEach((arg, index) => {
    if (index === 0) parts.push(hexAddress(arg));
    else if (index === 1) parts.push(hexUint(arg));
    else parts.push(hexBytes(arg));
  });
  return "0x" + parts.join("");
}

export function decodeCallData(callData: string): DecodedCall | null {
  const hex = strip0x(callData);
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  if (hex.length < 8 + 40 + 64) return null;
  const selector = "0x" + hex.slice(0, 8);
  const to = "0x" + hex.slice(8, 48);
  const amountHex = hex.slice(48, 112);
  const data = "0x" + hex.slice(112);
  return {
    selector,
    to,
    amount: Number(BigInt("0x" + amountHex)),
    data,
  };
}

export function decodeSender(op: UserOperation): string {
  return op.sender;
}

export function packUserOp(op: UserOperation): string {
  const hex = PACK_ORDER.map((field) => {
    const value = strip0x(op[field]);
    if (!/^[0-9a-fA-F]*$/.test(value)) {
      throw new Error(`non-hex field: ${field}`);
    }
    return value.toLowerCase();
  }).join("");
  return "0x" + hex;
}

export function validateUserOp(
  op: UserOperation,
  wallet: Wallet,
  pending: PendingVerdict,
): ValidationResult {
  if (!pending.allowed) {
    return {
      valid: false,
      reason: pending.reason ?? "SIMULATED_REJECT",
      walletStatus: wallet.status,
      effectivePolicy: wallet.policy,
    };
  }
  const decoded = decodeCallData(op.callData);
  if (!decoded) {
    return {
      valid: false,
      reason: "UNSUPPORTED_CALL",
      walletStatus: wallet.status,
      effectivePolicy: wallet.policy,
    };
  }
  const checks: GuardResult[] = [
    checkFreeze(wallet),
    checkPerTxLimit(wallet, decoded.amount),
    checkAllowlist(wallet, decoded.to),
    checkFunds(wallet, decoded.amount),
  ];
  for (const result of checks) {
    if (!result.allowed) {
      return {
        valid: false,
        reason: result.reason,
        walletStatus: wallet.status,
        effectivePolicy: wallet.policy,
      };
    }
  }
  return {
    valid: true,
    walletStatus: wallet.status,
    effectivePolicy: wallet.policy,
  };
}
