/**
 * Real DID/DPKI registry (D2): agent DID documents in a did:key-style shape,
 * resolvable from an in-module registry, with Ed25519 proof verification and
 * key rotation that revokes old signatures by replacing the active key.
 */

import { verifyAgentSignature } from "./signing";

const DID_CONTEXT = "https://www.w3.org/ns/did/v1";
const KEY_CONTEXT = "https://w3id.org/security/suites/ed25519-2020/v1";
const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export interface DidVerificationMethod {
  id: string;
  type: "Ed25519VerificationKey2020";
  controller: string;
  publicKeyBase64: string;
  publicKeyMultibase: string;
}

export interface DidDocument {
  "@context": string[];
  id: string;
  walletId: string;
  version: number;
  controller: string[];
  verificationMethod: DidVerificationMethod[];
  authentication: string[];
  alsoKnownAs: string[];
  created: number;
  updated: number;
}

const registry = new Map<string, DidDocument>();
const walletIndex = new Map<string, string>();

function toBase64url(value: string): string {
  return value.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function toBase58btc(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  let big = 0n;
  for (const byte of bytes) big = (big << 8n) | BigInt(byte);
  let out = "";
  while (big > 0n) {
    out = BASE58_ALPHABET[Number(big % 58n)] + out;
    big /= 58n;
  }
  return "1".repeat(zeros) + out;
}

function ed25519Multibase(publicKeyBase64: string): string {
  const der = Buffer.from(toBase64url(publicKeyBase64), "base64url");
  const raw = der.length >= 32 ? der.subarray(der.length - 32) : der;
  const keyBytes = new Uint8Array(raw.length + 1);
  keyBytes[0] = 0xed;
  keyBytes.set(raw, 1);
  return "z" + toBase58btc(keyBytes);
}

export function didDocument(
  walletId: string,
  publicKeyBase64: string,
  orgId?: string,
): DidDocument {
  const key = toBase64url(publicKeyBase64);
  const did = `did:aegis:${walletId}`;
  const now = Date.now();
  const methodId = `${did}#key`;
  const verificationMethod: DidVerificationMethod = {
    id: methodId,
    type: "Ed25519VerificationKey2020",
    controller: did,
    publicKeyBase64: key,
    publicKeyMultibase: ed25519Multibase(key),
  };
  return {
    "@context": [DID_CONTEXT, KEY_CONTEXT],
    id: did,
    walletId,
    version: 1,
    controller: [did],
    verificationMethod: [verificationMethod],
    authentication: [methodId],
    alsoKnownAs: orgId ? [`did:org:${orgId}`] : [],
    created: now,
    updated: now,
  };
}

export function registerDID(doc: DidDocument): void {
  registry.set(doc.id, doc);
  walletIndex.set(doc.walletId, doc.id);
}

export function resolveDID(did: string): DidDocument | null {
  return registry.get(did) ?? null;
}

export function didForWallet(walletId: string): string | null {
  return walletIndex.get(walletId) ?? null;
}

export function verifyDIDProof(
  did: string,
  message: string,
  signatureB64: string,
): boolean {
  const doc = registry.get(did);
  if (!doc) return false;
  const method = doc.verificationMethod[0];
  if (!method) return false;
  return verifyAgentSignature(method.publicKeyBase64, message, signatureB64);
}

export function rotateDIDKey(did: string, newPublicKeyB64: string): boolean {
  const doc = registry.get(did);
  if (!doc) return false;
  const key = toBase64url(newPublicKeyB64);
  const method = doc.verificationMethod[0];
  if (method) {
    method.publicKeyBase64 = key;
    method.publicKeyMultibase = ed25519Multibase(key);
  }
  doc.version += 1;
  doc.updated = Date.now();
  return true;
}
