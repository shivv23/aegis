import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverSlack, deliverEmail, pushAlertEnabled } from "@/core/push";
import type { OutboxEntry } from "@/core/types";

function entry(over: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    id: "o-1",
    walletId: "wallet-1",
    eventType: "STEP_UP_REQUIRED",
    payload: JSON.stringify({
      txId: "tx-1",
      amount: 100,
      to: "compute:0xCAFE0001",
      approveLink: "https://aegis.example.com/approve/tx-1?token=abc",
      declineLink: "https://aegis.example.com/approve/tx-1?token=def",
    }),
    createdAt: Date.now(),
    attemptCount: 0,
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("slack alert channel", () => {
  it("skips when no Slack URL is configured", async () => {
    delete process.env.AEGIS_SLACK_URL;
    expect(await deliverSlack(entry())).toBe(false);
  });

  it("posts an attachment with decision links when configured", async () => {
    process.env.AEGIS_SLACK_URL = "https://hooks.slack.com/services/x";
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const ok = await deliverSlack(entry());
    expect(ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hooks.slack.com/services/x");
    const body = JSON.parse(init.body as string);
    expect(body.attachments[0].title).toBe("Owner approval required");
    const fields = body.attachments[0].fields;
    expect(fields.some((f: { title: string }) => f.title === "Approve")).toBe(true);
    expect(fields.some((f: { title: string; value: string }) => f.value.includes("/approve/tx-1"))).toBe(true);
  });
});

describe("email alert channel (Resend)", () => {
  it("skips without a Resend key or recipient", async () => {
    delete process.env.AEGIS_RESEND_API_KEY;
    delete process.env.AEGIS_EMAIL_TO;
    expect(await deliverEmail(entry())).toBe(false);
  });

  it("sends via Resend when configured", async () => {
    process.env.AEGIS_RESEND_API_KEY = "re_test";
    process.env.AEGIS_EMAIL_TO = "ops@acme.com,fin@acme.com";
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const ok = await deliverEmail(entry());
    expect(ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_test");
    const body = JSON.parse(init.body as string);
    expect(body.to).toEqual(["ops@acme.com", "fin@acme.com"]);
    expect(body.subject).toContain("Owner approval required");
    expect(body.html).toContain("/approve/tx-1");
  });
});

describe("channel enablement", () => {
  it("reports enabled when any channel is configured", () => {
    process.env.AEGIS_WEBHOOK_URL = "https://example.com/hook";
    expect(pushAlertEnabled()).toBe(true);
  });
});
