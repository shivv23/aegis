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

/**
 * AEGIS_KMS_MASTER supplies the wrapping key directly. AEGIS_KMS_URL lets a
 * KMS (Vault, AWS/GCP) materialize it at runtime: the URL is fetched once and
 * the response body is hashed into the 32-byte master key (B6). A short TTL
 * cache avoids hammering the KMS on every encrypt/decrypt call.
 */
let cachedMaster: Buffer | null | undefined;
let cachedAt = 0;

async function materializeFromUrl(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(3000),
      headers: { Accept: "text/plain" },
    });
    if (!res.ok) return null;
    const material = await res.text();
    if (!material) return null;
    return createHash("sha256").update(material).digest();
  } catch {
    return null;
  }
}

/** sha256-derived 32-byte master key from the configured KMS material. */
export async function masterKey(): Promise<Buffer | null> {
  const url = process.env.AEGIS_KMS_URL;
  if (url) {
    const ttl = Number(process.env.AEGIS_KMS_CACHE_TTL_MS ?? 300000);
    if (cachedMaster !== undefined && Date.now() - cachedAt < ttl) {
      return cachedMaster;
    }
    cachedMaster = await materializeFromUrl(url);
    cachedAt = Date.now();
    return cachedMaster;
  }
  const material = process.env.AEGIS_KMS_MASTER;
  if (!material) return null;
  return createHash("sha256").update(material).digest();
}

export async function secretsEnabled(): Promise<boolean> {
  return Boolean(process.env.AEGIS_KMS_MASTER || process.env.AEGIS_KMS_URL);
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
export async function encryptSecret(plaintext: string): Promise<SecretEnvelope> {
  const master = await masterKey();
  if (!master) throw new Error("AEGIS_KMS_MASTER not configured");
  const dek = randomBytes(KEY_LEN);
  const cipher = gcmEncrypt(Buffer.from(plaintext, "utf8"), dek);
  const dekWrap = gcmEncrypt(dek, master);
  return { cipher, dek: dekWrap };
}

/** Decrypts a stored envelope. Returns null if tampered or key mismatch. */
export async function decryptSecret(envelope: SecretEnvelope): Promise<string | null> {
  const master = await masterKey();
  if (!master) return null;
  try {
    const dek = gcmDecrypt(envelope.dek, master);
    return gcmDecrypt(envelope.cipher, dek).toString("utf8");
  } catch {
    return null;
  }
}
