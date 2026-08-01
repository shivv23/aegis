import { describe, expect, it } from "vitest";
import {
  decodeCallData,
  decodeSender,
  encodeCallData,
  packUserOp,
  validateUserOp,
} from "./aa";
import type { UserOperation } from "./aa";
import type { Wallet } from "./types";

const TO = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const EXEC_SELECTOR = "0x6a761202";

const baseWallet: Wallet = {
  id: "w4337",
  name: "Agent-Bot",
  ownerDid: "did:aegis:w4337",
  status: "ACTIVE",
  balance: 5000,
  policy: {
    maxPerTx: 100,
    dailyLimit: 1000,
    monthlyLimit: 5000,
    velocityLimitPerMin: 30,
    allowlist: [TO],
  },
  createdAt: 0,
};

function makeOp(to: string, amount: number, nonce = "0x01"): UserOperation {
  return {
    sender: "0x1234000000000000000000000000000000000001",
    nonce,
    initCode: "0x",
    callData: encodeCallData("execTransaction", [to, amount, "0x"]),
    callGasLimit: "0x989680",
    verificationGasLimit: "0x989680",
    preVerificationGas: "0x989680",
    maxFeePerGas: "0x3b9aca00",
    maxPriorityFeePerGas: "0x3b9aca00",
    paymasterAndData: "0x",
    signature: "0x",
  };
}

const allow = { allowed: true };

describe("validateUserOp as the ERC-4337 guard gate", () => {
  it("allows a compliant op when the wallet is active and pending allows", () => {
    const r = validateUserOp(makeOp(TO, 50), baseWallet, allow);
    expect(r.valid).toBe(true);
    expect(r.walletStatus).toBe("ACTIVE");
    expect(r.effectivePolicy).toEqual(baseWallet.policy);
  });

  it("denies when the wallet is frozen", () => {
    const frozen = { ...baseWallet, status: "FROZEN" as const };
    const r = validateUserOp(makeOp(TO, 1), frozen, allow);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("WALLET_FROZEN");
    expect(r.walletStatus).toBe("FROZEN");
  });

  it("denies when the amount exceeds maxPerTx", () => {
    const r = validateUserOp(makeOp(TO, 101), baseWallet, allow);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("LIMIT_EXCEEDED");
  });

  it("denies when the recipient is not on the allowlist", () => {
    const r = validateUserOp(makeOp(OTHER, 10), baseWallet, allow);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("NOT_ALLOWLISTED");
  });

  it("denies on insufficient funds", () => {
    const poor = { ...baseWallet, balance: 30 };
    const r = validateUserOp(makeOp(TO, 50), poor, allow);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("INSUFFICIENT_FUNDS");
  });

  it("honors a pending (simulated) denial with its reason", () => {
    const r = validateUserOp(
      makeOp(TO, 10),
      baseWallet,
      { allowed: false, reason: "sim-offline" },
    );
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("sim-offline");
  });

  it("reports a default reason when pending denies without one", () => {
    const r = validateUserOp(makeOp(TO, 10), baseWallet, { allowed: false });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("SIMULATED_REJECT");
  });

  it("rejects callData it cannot decode as execTransaction", () => {
    const op = { ...makeOp(TO, 10), callData: "0xdeadbeef" };
    const r = validateUserOp(op, baseWallet, allow);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("UNSUPPORTED_CALL");
  });
});

describe("callData encoding/decoding", () => {
  it("produces expected abi.encodePacked-style hex for a known call", () => {
    const expected =
      EXEC_SELECTOR +
      TO.slice(2) +
      (100).toString(16).padStart(64, "0") +
      "deadbeef";
    expect(encodeCallData("execTransaction", [TO, 100, "0xdeadbeef"])).toBe(
      expected,
    );
    expect(encodeCallData("0x6a761202", [TO, 100, "0xdeadbeef"])).toBe(expected);
  });

  it("round-trips through decodeCallData", () => {
    const encoded = encodeCallData("execTransaction", [TO, 100, "0xdeadbeef"]);
    const decoded = decodeCallData(encoded);
    expect(decoded).toEqual({
      selector: EXEC_SELECTOR,
      to: TO,
      amount: 100,
      data: "0xdeadbeef",
    });
  });

  it("returns null for malformed callData", () => {
    expect(decodeCallData("0xdeadbeef")).toBeNull();
    expect(decodeCallData("not-hex")).toBeNull();
  });
});

describe("UserOperation helpers", () => {
  it("decodeSender returns the sender address", () => {
    const op = makeOp(TO, 10);
    expect(decodeSender(op)).toBe(op.sender);
  });

  it("packUserOp is deterministic for identical ops", () => {
    const a = makeOp(TO, 10);
    const b = makeOp(TO, 10);
    expect(packUserOp(a)).toBe(packUserOp(b));
    expect(packUserOp(a).startsWith("0x")).toBe(true);
  });

  it("packUserOp changes with the nonce", () => {
    const a = packUserOp(makeOp(TO, 10, "0x01"));
    const b = packUserOp(makeOp(TO, 10, "0x02"));
    expect(a).not.toBe(b);
  });
});
