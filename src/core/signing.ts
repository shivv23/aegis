import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import type { SignedTransferRequest } from "./types";

/**
 * Ed25519 agent keypairs. The agent holds the private key and signs every
 * transfer request; the rail verifies against the registered public key.
 * This replaces bearer secrets at the agent boundary: a compromised or
 * leaked token is worthless without the private key, and the agent's
 * identity is cryptographic.
 */

export const MAX_SKEW_MS = Number(process.env.AEGIS_SIGNATURE_SKEW_MS ?? 300000);

export interface AgentKeyPair {
  publicKey: string;
  privateKey: string;
}

export function generateAgentKeyPair(): AgentKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64url"),
    privateKey: privateKey
      .export({ type: "pkcs8", format: "der" })
      .toString("base64url"),
  };
}

/**
 * Deterministic canonical message the agent signs. Field order matters; the
 * same order is used by the rail at verification time.
 */
export function canonicalAgentMessage(req: SignedTransferRequest): string {
  return [
    "aegis-agent-transfer",
    "v1",
    req.walletId,
    req.nonce,
    req.requestedAt,
    req.to,
    req.amount,
    req.purpose,
  ].join("|");
}

export function signAgentMessage(
  privateKey: string,
  message: string,
): string {
  const key = createPrivateKey({
    key: Buffer.from(privateKey, "base64url"),
    type: "pkcs8",
    format: "der",
  });
  return sign(null, Buffer.from(message), key).toString("base64url");
}

export function verifyAgentSignature(
  publicKey: string,
  message: string,
  signature: string,
): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKey, "base64url"),
      type: "spki",
      format: "der",
    });
    return verify(null, Buffer.from(message), key, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

/**
 * Validates a signed transfer envelope: wallet ownership, request freshness,
 * and the Ed25519 signature over the canonical message.
 */
export function validateSignedTransfer(
  req: SignedTransferRequest,
  publicKey: string,
  signature: string,
  now = Date.now(),
): { ok: true } | { ok: false; reason: "INVALID_SIGNATURE" | "REQUEST_EXPIRED" } {
  if (Math.abs(now - req.requestedAt) > MAX_SKEW_MS) {
    return { ok: false, reason: "REQUEST_EXPIRED" };
  }
  const message = canonicalAgentMessage(req);
  if (!verifyAgentSignature(publicKey, message, signature)) {
    return { ok: false, reason: "INVALID_SIGNATURE" };
  }
  return { ok: true };
}
