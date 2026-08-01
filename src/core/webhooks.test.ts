import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createWebhook,
  deleteWebhook,
  getWebhook,
  getStore,
  listWebhookDeliveries,
  listWebhooks,
  recordWebhookDelivery,
  updateWebhook,
} from "@/core/store";
import { deliverRegisteredWebhooks } from "@/core/push";
import { SEED_WALLET_ID } from "@/core/seed";

const tick = (ms = 6) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  const existing = await listWebhooks();
  for (const w of existing) await deleteWebhook(w.id);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AEGIS_WEBHOOK_URL;
});

describe("webhook console (E1)", () => {
  it("creates, lists, updates and deletes endpoints", async () => {
    const created = await createWebhook({
      url: "https://ops.acme.dev/hooks/aegis",
      secret: "s3cret",
      eventTypes: ["BLOCKED", "STEP_UP_REQUIRED"],
      orgId: SEED_WALLET_ID,
    });
    expect(created.active).toBe(true);
    expect(created.secret).toBe("s3cret");

    const listed = await listWebhooks();
    expect(listed.some((w) => w.id === created.id)).toBe(true);

    const updated = await updateWebhook(created.id, { active: false });
    expect(updated?.active).toBe(false);
    expect((await getWebhook(created.id))?.active).toBe(false);

    await deleteWebhook(created.id);
    expect((await getWebhook(created.id))).toBeNull();
  });

  it("records deliveries and returns them newest-first", async () => {
    const endpoint = await createWebhook({ url: "https://x.example.com", secret: "s", eventTypes: [] });
    const first = await recordWebhookDelivery(endpoint.id, "BLOCKED", { txId: "t1" }, "DELIVERED", 200);
    await tick();
    const second = await recordWebhookDelivery(endpoint.id, "STEP_UP_REQUIRED", { txId: "t2" }, "FAILED", 500);

    const log = await listWebhookDeliveries(endpoint.id);
    expect(log.map((d) => d.id)).toEqual([second.id, first.id]);
    expect(log[0].httpStatus).toBe(500);
  });

  it("fans out to registered endpoints with an HMAC signature and records the attempt", async () => {
    const endpoint = await createWebhook({
      url: "https://hook.example.com/ingest",
      secret: "whsec_abc",
      eventTypes: ["BLOCKED"],
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const ok = await deliverRegisteredWebhooks({
      id: "o-1",
      walletId: SEED_WALLET_ID,
      eventType: "BLOCKED",
      payload: JSON.stringify({ txId: "tx-9", amount: 250 }),
      createdAt: Date.now(),
      attemptCount: 1,
    });

    expect(ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hook.example.com/ingest");
    const headers = init!.headers as Record<string, string>;
    expect(typeof headers["x-aegis-webhook"]).toBe("string");
    expect(headers["x-aegis-webhook"]!.length).toBe(64);

    const log = await listWebhookDeliveries(endpoint.id);
    expect(log).toHaveLength(1);
    expect(log[0].status).toBe("DELIVERED");
    expect(log[0].httpStatus).toBe(200);
  });

  it("skips endpoints that do not subscribe to the event type", async () => {
    await createWebhook({ url: "https://quiet.example.com", secret: "s", eventTypes: ["ESCROW_RELEASED"] });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await deliverRegisteredWebhooks({
      id: "o-1",
      walletId: SEED_WALLET_ID,
      eventType: "BLOCKED",
      payload: "{}",
      createdAt: Date.now(),
      attemptCount: 0,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
