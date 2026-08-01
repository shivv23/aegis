import { afterEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, masterKey, secretsEnabled } from "./secrets";

const OLD = process.env.AEGIS_KMS_MASTER;

afterEach(() => {
  if (OLD) process.env.AEGIS_KMS_MASTER = OLD;
  else delete process.env.AEGIS_KMS_MASTER;
});

describe("envelope encryption (B1)", () => {
  it("is disabled without a master key", async () => {
    delete process.env.AEGIS_KMS_MASTER;
    expect(await secretsEnabled()).toBe(false);
    expect(await masterKey()).toBeNull();
    await expect(encryptSecret("x")).rejects.toThrow("AEGIS_KMS_MASTER not configured");
  });

  it("round-trips a secret and never stores plaintext", async () => {
    process.env.AEGIS_KMS_MASTER = "test-master";
    const envelope = await encryptSecret("pkcs8-PrivateKey-…");
    expect(JSON.stringify(envelope)).not.toContain("PrivateKey");
    expect(await decryptSecret(envelope)).toBe("pkcs8-PrivateKey-…");
  });

  it("detects tampering in the ciphertext", async () => {
    process.env.AEGIS_KMS_MASTER = "test-master";
    const envelope = await encryptSecret("secret");
    const raw = Buffer.from(envelope.cipher, "base64");
    raw[raw.length - 1] ^= 0xff;
    const tampered = { ...envelope, cipher: raw.toString("base64") };
    expect(await decryptSecret(tampered)).toBeNull();
  });

  it("fails to decrypt with a different master key", async () => {
    process.env.AEGIS_KMS_MASTER = "master-a";
    const envelope = await encryptSecret("secret");
    process.env.AEGIS_KMS_MASTER = "master-b";
    expect(await decryptSecret(envelope)).toBeNull();
  });

  it("uses a fresh DEK per secret", async () => {
    process.env.AEGIS_KMS_MASTER = "test-master";
    const a = await encryptSecret("same");
    const b = await encryptSecret("same");
    expect(a.cipher).not.toBe(b.cipher);
    expect(a.dek).not.toBe(b.dek);
  });
});
