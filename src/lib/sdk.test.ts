import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { Aegis } from "@/lib/sdk";
import { canonicalAgentMessage } from "@/core/signing";
import type { SignedTransferRequest } from "@/core/types";

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url"),
  };
}

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("Aegis SDK", () => {
  it("throws when no credentials are provided", () => {
    expect(() => new Aegis({})).toThrow("apiKey or a privateKey");
    expect(() => new Aegis({ privateKey: "x" })).toThrow("walletId is required");
  });

  it("signs transfers exactly like the rail's canonical message", () => {
    const input = { to: "compute:0xCAFE0001", amount: 30, purpose: "GPU burst" };
    const signed: SignedTransferRequest = {
      walletId: "wallet-tradingbot-42",
      nonce: "n-1",
      requestedAt: 1700000000000,
      to: input.to,
      amount: input.amount,
      purpose: input.purpose,
    };
    expect(Aegis.canonicalMessage({ ...input, walletId: signed.walletId, nonce: "n-1", requestedAt: 1700000000000 })).toBe(
      canonicalAgentMessage(signed),
    );
  });

  it("sends an Ed25519-signed transfer (signed identity mode)", async () => {
    const { privateKey, publicKey } = keypair();
    const fetchMock = mockFetch(201, { status: "PENDING", id: "tx-1" });
    vi.stubGlobal("fetch", fetchMock);

    const aegis = new Aegis({
      baseUrl: "https://example.com",
      walletId: "wallet-tradingbot-42",
      privateKey,
    });
    const r = await aegis.transfer({ to: "compute:0xCAFE0001", amount: 30, purpose: "GPU burst" });

    expect(r.ok).toBe(true);
    expect(r.status).toBe(201);
    expect(r.body.status).toBe("PENDING");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["x-aegis-wallet"]).toBe("wallet-tradingbot-42");
    expect(Number(headers["x-aegis-timestamp"])).toBeGreaterThan(0);
    expect(headers["x-aegis-signature"]).toBeTruthy();

    const body = JSON.parse(init.body as string);
    expect(body.nonce).toBeTruthy();
    expect(body.to).toBe("compute:0xCAFE0001");

    const message = Aegis.canonicalMessage({
      to: body.to,
      amount: body.amount,
      purpose: body.purpose,
      walletId: "wallet-tradingbot-42",
      nonce: body.nonce,
      requestedAt: Number(headers["x-aegis-timestamp"]),
    });
    const { verify } = await import("node:crypto");
    const ok = verify(
      null,
      Buffer.from(message),
      { key: Buffer.from(publicKey, "base64url"), type: "spki", format: "der" },
      Buffer.from(headers["x-aegis-signature"], "base64url"),
    );
    expect(ok).toBe(true);
  });

  it("uses the bearer JWT when no private key is provided", async () => {
    const fetchMock = mockFetch(200, { ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const aegis = new Aegis({ baseUrl: "https://example.com", apiKey: "jwt-token" });
    await aegis.health();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer jwt-token");
  });

  it("propagates guard denials instead of throwing", async () => {
    const fetchMock = mockFetch(403, { error: "Not allowed", reason: "NOT_ALLOWLISTED" });
    vi.stubGlobal("fetch", fetchMock);

    const aegis = new Aegis({ apiKey: "jwt" });
    const r = await aegis.transfer({ to: "drain:0xBADBEEF", amount: 20 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
    expect(r.body.reason).toBe("NOT_ALLOWLISTED");
  });
});
