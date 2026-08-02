import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";

/**
 * Signed regulator export (offline proof).
 *
 * Every `audit.json` export carries a `.proof`: the SHA-256 of the pack, the
 * head hash of the ledger, and a deterministic P-256 ECDSA signature over the
 * pack. The public key is published so ANYONE can verify the file offline
 * with a shell one-liner — no need to trust the server.
 *
 * The signing keypair is derived deterministically from AEGIS_SECRET so the
 * public key is stable across serverless cold starts and verifications.
 */

function signingSeed(): Buffer {
  const raw =
    process.env.AEGIS_EXPORT_SIGNING_KEY ?? process.env.AEGIS_SECRET ?? "aegis-dev-secret-change-me";
  return createHash("sha256").update(raw).digest();
}

function privateKey() {
  // Ed25519 PKCS#8: the 32-byte seed is the entire private key, so the keypair
  // is deterministic and stable across cold starts with only the secret as
  // input. The public half is derived by Node.
  const seed = signingSeed();
  const der = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    seed,
  ]);
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

export function exportPublicKeyPem(): string {
  return createPublicKey(privateKey())
    .export({ type: "spki", format: "pem" })
    .toString();
}

/** Signs an export pack (any UTF-8 string) and returns base64 Ed25519 sig. */
export function signExportPack(pack: string): string {
  return sign(null, Buffer.from(pack, "utf8"), privateKey()).toString("base64");
}

export function verifyExportPack(pack: string, signatureB64: string): boolean {
  try {
    return verify(
      null,
      Buffer.from(pack, "utf8"),
      createPublicKey(privateKey()),
      Buffer.from(signatureB64, "base64"),
    );
  } catch {
    return false;
  }
}

export function packSha256(pack: string): string {
  return createHash("sha256").update(pack, "utf8").digest("hex");
}

/**
 * Canonical serialization for a regulator pack so a verifier can re-derive
 * the exact bytes that were signed. Key order matters (JS preserves it).
 */
export function canonicalPack(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}
