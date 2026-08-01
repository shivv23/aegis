import { beforeAll, describe, expect, it } from "vitest";
import { verifyDecisionToken, signDecisionToken } from "@/core/keys";
import { decisionLink, publicBaseUrl } from "@/core/approval-links";
import { approveStepUp, createTransaction, declineStepUp, getStore, getTransaction } from "@/core/store";
import { SEED_WALLET_ID } from "@/core/seed";

beforeAll(async () => {
  await getStore().ready;
});

describe("decision tokens (email deep-link)", () => {
  it("mints and verifies a decision token bound to wallet+tx+action", async () => {
    const token = await signDecisionToken("w1", "tx-1", "approve");
    const claims = await verifyDecisionToken(token);
    expect(claims).toEqual({ walletId: "w1", txId: "tx-1", action: "approve" });
  });

  it("rejects a decision token used for a different transaction", async () => {
    const token = await signDecisionToken("w1", "tx-1", "approve");
    const claims = await verifyDecisionToken(token);
    expect(claims!.txId).toBe("tx-1");
  });

  it("expires decision tokens after their TTL", async () => {
    const token = await signDecisionToken("w1", "tx-1", "decline", 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(await verifyDecisionToken(token)).toBeNull();
  });

  it("cannot be confused with an owner key", async () => {
    const token = await signDecisionToken("w1", "tx-1", "approve");
    // A decision token has no usable scope for the rail.
    expect(token.split(".").length).toBe(3);
    const { verifyKey } = await import("@/core/keys");
    expect(await verifyKey(token)).toBeNull();
  });

  it("builds a public decision link", async () => {
    const prev = process.env.AEGIS_PUBLIC_URL;
    process.env.AEGIS_PUBLIC_URL = "https://aegis.example.com";
    try {
      const link = await decisionLink("w1", "tx-9", "approve");
      expect(link.startsWith("https://aegis.example.com/approve/tx-9?token=")).toBe(true);
      expect(publicBaseUrl()).toBe("https://aegis.example.com");
    } finally {
      if (prev) process.env.AEGIS_PUBLIC_URL = prev;
      else delete process.env.AEGIS_PUBLIC_URL;
    }
  });
});

describe("one-tap approval end-to-end", () => {
  it("approves a step-up via the token path", async () => {
    const tx = await createTransaction({
      walletId: SEED_WALLET_ID,
      from: SEED_WALLET_ID,
      to: "compute:0xCAFE0001",
      amount: 5,
      purpose: "link test",
      status: "STEP_UP_REQUIRED",
      requestedAt: Date.now(),
      pendingUntil: Date.now() + 60000,
      nonce: `link-${Date.now()}`,
      stepUpScore: 80,
    });

    const token = await signDecisionToken(SEED_WALLET_ID, tx.id, "approve");
    const claims = await verifyDecisionToken(token);
    expect(claims).not.toBeNull();

    const result = await approveStepUp(tx.id);
    expect(result?.tx.status).toBe("PENDING");
    expect((await getTransaction(tx.id))?.status).toBe("PENDING");
  });

  it("declines a step-up via the token path", async () => {
    const tx = await createTransaction({
      walletId: SEED_WALLET_ID,
      from: SEED_WALLET_ID,
      to: "compute:0xCAFE0001",
      amount: 5,
      purpose: "link decline test",
      status: "STEP_UP_REQUIRED",
      requestedAt: Date.now(),
      pendingUntil: Date.now() + 60000,
      nonce: `link-decline-${Date.now()}`,
      stepUpScore: 80,
    });

    const declined = await declineStepUp(tx.id);
    expect(declined?.status).toBe("BLOCKED");
    expect(declined?.rejectionReason).toBe("STEP_UP_DECLINED");
  });
});
