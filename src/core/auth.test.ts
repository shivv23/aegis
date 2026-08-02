import { beforeAll, describe, expect, it } from "vitest";
import {
  emailConfigured,
  magicLinkFor,
  parseSessionCookie,
  signMagicToken,
  verifyMagicToken,
  verifyMagicTokenClaims,
} from "@/core/auth";
import { authorize, authorizeRead } from "@/core/api";
import { signKey, verifyKey } from "@/core/keys";
import {
  consumeMagicToken,
  createSession,
  getSession,
  getStore,
  isApiKeyRevoked,
  listRequestAudit,
  listSecurityEvents,
  listSessions,
  recordRequestAudit,
  revokeApiKeyByHash,
  revokeSession,
} from "@/core/store";

beforeAll(() => {
  process.env.AEGIS_AUTH_SECRET = process.env.AEGIS_AUTH_SECRET ?? "test-secret-for-auth";
  process.env.AEGIS_PUBLIC_URL = "https://aegis.example.com";
  delete process.env.AEGIS_RESEND_API_KEY;
  return getStore().ready;
});

describe("magic-link auth (1.1)", () => {
  it("signs and verifies a magic link and recovers the email", async () => {
    const token = await signMagicToken("Owner@Acme.Dev ");
    const email = await verifyMagicToken(token);
    expect(email).toBe("owner@acme.dev");
  });

  it("rejects tampered or expired tokens", async () => {
    const token = await signMagicToken("a@b.dev");
    expect(await verifyMagicToken(token.slice(0, -2) + "xx")).toBeNull();
    expect(await verifyMagicToken("not-a-jwt")).toBeNull();
  });

  it("builds absolute magic links from the public base URL", async () => {
    const link = magicLinkFor("tok123");
    expect(link.startsWith("https://aegis.example.com/api/auth/magic-link/verify?token=")).toBe(true);
  });

  it("treats email as configured only when Resend is available", () => {
    expect(emailConfigured()).toBe(false);
    process.env.AEGIS_RESEND_API_KEY = "re_x";
    process.env.AEGIS_EMAIL_FROM = "AEGIS <x@y.dev>";
    expect(emailConfigured()).toBe(true);
    delete process.env.AEGIS_RESEND_API_KEY;
    delete process.env.AEGIS_EMAIL_FROM;
  });

  it("parses the httpOnly session cookie out of a cookie header", () => {
    expect(parseSessionCookie(null)).toBeNull();
    expect(parseSessionCookie("aegis_session=s%3Aabc; other=1")).toBe("s:abc");
  });
});

describe("session store (1.1)", () => {
  it("creates, lists, touches and revokes sessions per email", async () => {
    const created = await createSession({
      email: "Ops@Acme.dev",
      ip: "10.0.0.1",
      userAgent: "curl",
    });
    expect(created.email).toBe("ops@acme.dev");

    expect((await getSession(created.id))?.revokedAt).toBeUndefined();
    expect((await listSessions("ops@acme.dev")).some((s) => s.id === created.id)).toBe(true);

    expect(await revokeSession(created.id)).toBe(true);
    expect(await revokeSession("missing-id")).toBe(false);
    expect((await getSession(created.id))?.revokedAt).toBeTypeOf("number");
  });
});

describe("auth hardening (P2-2)", () => {
  it("magic links are single-use: the second consumption is rejected", async () => {
    const claims = await verifyMagicTokenClaims(await signMagicToken("solo@acme.dev"));
    expect(claims).not.toBeNull();
    expect(await consumeMagicToken(claims!.jti, claims!.email)).toBe(true);
    expect(await consumeMagicToken(claims!.jti, claims!.email)).toBe(false);
    // The raw token is still valid but a fresh jti consumes independently.
    const second = await verifyMagicTokenClaims(await signMagicToken("solo@acme.dev"));
    expect(await consumeMagicToken(second!.jti, second!.email)).toBe(true);
  });

  it("revoking an API key by hash makes it report revoked", async () => {
    const hash = "deadbeefdeadbeefdeadbeefdeadbeef";
    expect(await isApiKeyRevoked(hash)).toBe(false);
    await revokeApiKeyByHash(hash, "owner");
    expect(await isApiKeyRevoked(hash)).toBe(true);
    // Idempotent: revoking the same hash again must not throw (ON CONFLICT).
    await revokeApiKeyByHash(hash, "owner");
    expect(await isApiKeyRevoked(hash)).toBe(true);
  });
});

describe("auditor read-only role", () => {
  it("mints and verifies an auditor-scoped key", async () => {
    const claims = await verifyKey(await signKey("*", "auditor"));
    expect(claims?.scope).toBe("auditor");
    expect(claims?.role).toBe("auditor");
  });

  it("auditor can read but never write (authorizeRead vs authorize)", async () => {
    const auditor = await verifyKey(await signKey("*", "auditor"));
    expect(authorizeRead(auditor).ok).toBe(true);
    // The same key fails the owner check every mutating route uses.
    expect(authorize(auditor, "owner").ok).toBe(false);
  });

  it("auditor is still wallet-scoped when minted per wallet", async () => {
    const auditor = await verifyKey(await signKey("wallet-a", "auditor"));
    expect(authorizeRead(auditor, "wallet-a").ok).toBe(true);
    expect(authorizeRead(auditor, "wallet-b").ok).toBe(false);
  });
});

describe("security events feed", () => {
  it("curates failed auth and sensitive actions out of the request audit", async () => {
    await recordRequestAudit({
      method: "GET",
      path: "/api/transactions",
      keyHash: "aaaa",
      scope: "owner",
      result: "OK",
    });
    await recordRequestAudit({
      method: "GET",
      path: "/api/wallet",
      keyHash: "bbbb",
      scope: "auditor",
      result: "INVALID",
    });
    await recordRequestAudit({
      method: "POST",
      path: "/api/wallet/wallet-x/freeze",
      keyHash: "cccc",
      scope: "owner",
      result: "OK",
    });
    await recordRequestAudit({
      method: "GET",
      path: "/api/currencies",
      keyHash: "dddd",
      scope: "auditor",
      result: "OK",
    });

    const events = await listSecurityEvents();
    const paths = events.map((e) => e.path);
    // The benign read is filtered out; failed auth + freeze are kept.
    expect(paths).not.toContain("/api/transactions");
    expect(paths).not.toContain("/api/currencies");
    expect(paths).toContain("/api/wallet");
    expect(paths).toContain("/api/wallet/wallet-x/freeze");

    const all = await listRequestAudit();
    expect(all.length).toBeGreaterThanOrEqual(4);
  });
});

