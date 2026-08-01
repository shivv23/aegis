import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Envelope encryption for secrets at rest (KMS-ready).
 *
 * Each secret is encrypted with a fresh data-encryption key (DEK) under
 * AES-256-GCM; the DEK is then wrapped with a master key derived from
 * `AEGIS_KMS_MASTER`. Only the ciphertext + wrapped DEK hit the database —
 * the master key lives in the environment (or a KMS that materializes it).
 *
 *   record.cipher = base64(iv ‖ authTag ‖ ciphertext)      (DEK keyed)
 *   record.dek    = base64(iv ‖ authTag ‖ wrappedDek)      (master keyed)
 */

export interface SecretEnvelope {
  cipher: string;
  dek: string;
}

const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

/** sha256-derived 32-byte master key from the configured KMS material. */
export function masterKey(): Buffer | null {
  const material = process.env.AEGIS_KMS_MASTER;
  if (!material) return null;
  return createHash("sha256").update(material).digest();
}

export function secretsEnabled(): boolean {
  return Boolean(process.env.AEGIS_KMS_MASTER);
}

function toBuffer(b64: string): Buffer {
  return Buffer.from(b64, "base64");
}

function gcmEncrypt(plaintext: Buffer, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

function gcmDecrypt(envelope: string, key: Buffer): Buffer {
  const raw = toBuffer(envelope);
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = raw.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** Encrypts a secret into its stored envelope. Throws if no master key. */
export function encryptSecret(plaintext: string): SecretEnvelope {
  const master = masterKey();
  if (!master) throw new Error("AEGIS_KMS_MASTER not configured");
  const dek = randomBytes(KEY_LEN);
  const cipher = gcmEncrypt(Buffer.from(plaintext, "utf8"), dek);
  const dekWrap = gcmEncrypt(dek, master);
  return { cipher, dek: dekWrap };
}

/** Decrypts a stored envelope. Returns null if tampered or key mismatch. */
export function decryptSecret(envelope: SecretEnvelope): string | null {
  const master = masterKey();
  if (!master) return null;
  try {
    const dek = gcmDecrypt(envelope.dek, master);
    return gcmDecrypt(envelope.cipher, dek).toString("utf8");
  } catch {
    return null;
  }
}
