import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getSecret, getStore, listSecretMeta, putSecret, deleteSecret } from "@/core/store";
import { SEED_WALLET_ID } from "@/core/seed";

const OLD = process.env.AEGIS_KMS_MASTER;

beforeAll(async () => {
  await getStore().ready;
});

afterAll(() => {
  if (OLD) process.env.AEGIS_KMS_MASTER = OLD;
  else delete process.env.AEGIS_KMS_MASTER;
});

describe("secrets at rest (B1 store integration)", () => {
  it("stores ciphertext only and round-trips decryption", async () => {
    process.env.AEGIS_KMS_MASTER = "test-master";
    await putSecret(SEED_WALLET_ID, "agent-private-key", "pkcs8-…secret");
    const { rows } = await getStore().client.execute(
      "SELECT cipher FROM secrets WHERE wallet_id = ? AND kind = ?",
      [SEED_WALLET_ID, "agent-private-key"],
    );
    expect(rows[0].cipher as string).not.toContain("pkcs8-…secret");
    expect(await getSecret(SEED_WALLET_ID, "agent-private-key")).toBe("pkcs8-…secret");
    const meta = await listSecretMeta(SEED_WALLET_ID);
    expect(meta.some((m) => m.kind === "agent-private-key")).toBe(true);
    await deleteSecret(SEED_WALLET_ID, "agent-private-key");
    expect(await getSecret(SEED_WALLET_ID, "agent-private-key")).toBeNull();
  });

  it("refuses to store when no master key is configured", async () => {
    delete process.env.AEGIS_KMS_MASTER;
    const stored = await putSecret(SEED_WALLET_ID, "ephemeral", "x");
    expect(stored).toBeNull();
  });
});
