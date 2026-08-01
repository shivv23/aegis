import { describe, expect, it } from "vitest";
import {
  MAX_SKEW_MS,
  canonicalAgentMessage,
  generateAgentKeyPair,
  signAgentMessage,
  validateSignedTransfer,
  verifyAgentSignature,
} from "@/core/signing";
import type { SignedTransferRequest } from "@/core/types";

function req(over: Partial<SignedTransferRequest> = {}): SignedTransferRequest {
  return {
    walletId: "wallet-tradingbot-42",
    to: "compute:0xCAFE0001",
    amount: 42.5,
    purpose: "GPU burst",
    nonce: "nonce-1",
    requestedAt: Date.now(),
    ...over,
  };
}

describe("Ed25519 agent signing", () => {
  it("generates a keypair and verifies its own signature", () => {
    const { publicKey, privateKey } = generateAgentKeyPair();
    const message = canonicalAgentMessage(req());
    const sig = signAgentMessage(privateKey, message);
    expect(verifyAgentSignature(publicKey, message, sig)).toBe(true);
  });

  it("rejects a signature over a tampered message", () => {
    const { publicKey, privateKey } = generateAgentKeyPair();
    const good = canonicalAgentMessage(req());
    const tampered = canonicalAgentMessage(req({ amount: 999999 }));
    const sig = signAgentMessage(privateKey, good);
    expect(verifyAgentSignature(publicKey, tampered, sig)).toBe(false);
  });

  it("rejects a signature from the wrong key", () => {
    const a = generateAgentKeyPair();
    const b = generateAgentKeyPair();
    const message = canonicalAgentMessage(req());
    const sig = signAgentMessage(a.privateKey, message);
    expect(verifyAgentSignature(b.publicKey, message, sig)).toBe(false);
  });

  it("rejects garbage signatures without throwing", () => {
    const { publicKey } = generateAgentKeyPair();
    const message = canonicalAgentMessage(req());
    expect(verifyAgentSignature(publicKey, message, "not-a-signature")).toBe(false);
  });

  it("validateSignedTransfer accepts a valid signed envelope", () => {
    const { publicKey, privateKey } = generateAgentKeyPair();
    const r = req();
    const sig = signAgentMessage(privateKey, canonicalAgentMessage(r));
    expect(validateSignedTransfer(r, publicKey, sig)).toEqual({ ok: true });
  });

  it("validateSignedTransfer rejects an expired request", () => {
    const { publicKey, privateKey } = generateAgentKeyPair();
    const r = req({ requestedAt: Date.now() - (MAX_SKEW_MS + 1000) });
    const sig = signAgentMessage(privateKey, canonicalAgentMessage(r));
    expect(validateSignedTransfer(r, publicKey, sig)).toEqual({
      ok: false,
      reason: "REQUEST_EXPIRED",
    });
  });

  it("validateSignedTransfer rejects a request with a valid signature for a different payload", () => {
    const { publicKey, privateKey } = generateAgentKeyPair();
    const r = req();
    const sig = signAgentMessage(
      privateKey,
      canonicalAgentMessage(req({ to: "drain:0xBAD" })),
    );
    expect(validateSignedTransfer(r, publicKey, sig)).toEqual({
      ok: false,
      reason: "INVALID_SIGNATURE",
    });
  });

  it("mints unique keypairs", () => {
    const a = generateAgentKeyPair();
    const b = generateAgentKeyPair();
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.privateKey).not.toBe(b.privateKey);
  });
});
