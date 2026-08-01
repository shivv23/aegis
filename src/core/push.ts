/**
 * Multi-channel alert delivery for the ops outbox.
 *
 * Channels (all optional, all fire-and-forget — never block the money path):
 *  - webhook : AEGIS_WEBHOOK_URL (+ AEGIS_WEBHOOK_SECRET)
 *  - slack   : AEGIS_SLACK_URL (incoming-webhook URL; Slack formats the payload)
 *  - email   : AEGIS_RESEND_API_KEY + AEGIS_EMAIL_FROM + AEGIS_EMAIL_TO
 *              (Resend transactional API; AEGIS_EMAIL_TO may be comma-separated)
 */
import type { OutboxEntry } from "./types";

export function pushAlertEnabled(): boolean {
  return Boolean(
    process.env.AEGIS_WEBHOOK_URL || process.env.AEGIS_SLACK_URL || process.env.AEGIS_RESEND_API_KEY,
  );
}

const SLACK_COLORS: Record<string, string> = {
  STEP_UP_REQUIRED: "#f59e0b",
  STEP_UP_APPROVED: "#22c55e",
  STEP_UP_DECLINED: "#ef4444",
  TX_BLOCKED: "#ef4444",
  TX_SETTLED: "#22c55e",
  WALLET_FROZEN: "#ef4444",
  WALLET_UNFROZEN: "#22c55e",
  ANOMALY: "#f59e0b",
  BREAKER_TRIPPED: "#ef4444",
};

const HUMAN_LABELS: Record<string, string> = {
  STEP_UP_REQUIRED: "Owner approval required",
  STEP_UP_APPROVED: "Transfer approved",
  STEP_UP_DECLINED: "Transfer declined",
  TX_BLOCKED: "Transfer blocked by guard",
  TX_SETTLED: "Transfer settled",
  WALLET_FROZEN: "Kill switch engaged",
  WALLET_UNFROZEN: "Kill switch released",
  ANOMALY: "Guard anomaly",
  BREAKER_TRIPPED: "Circuit breaker tripped",
};

/** Sends the event payload to Slack (if configured). */
export async function deliverSlack(entry: OutboxEntry): Promise<boolean> {
  const slackUrl = process.env.AEGIS_SLACK_URL;
  if (!slackUrl) return false;
  try {
    const payload = parsePayload(entry);
    const fallback = HUMAN_LABELS[entry.eventType] ?? entry.eventType;
    const res = await fetch(slackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        attachments: [
          {
            color: SLACK_COLORS[entry.eventType] ?? "#38bdf8",
            fallback,
            title: fallback,
            fields: [
              ...Object.entries(payload)
                .filter(([k]) => k !== "approveLink" && k !== "declineLink")
                .map(([k, v]) => ({
                  title: k,
                  value: String(v).slice(0, 200),
                  short: true,
                })),
              ...(payload.approveLink
                ? [{ title: "Approve", value: payload.approveLink as string, short: false }]
                : []),
              ...(payload.declineLink
                ? [{ title: "Decline", value: payload.declineLink as string, short: false }]
                : []),
            ],
            footer: `aegis · wallet ${String(entry.walletId).slice(0, 12)}`,
            ts: Math.floor(entry.createdAt / 1000),
          },
        ],
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Sends the event to Resend (if configured). */
export async function deliverEmail(entry: OutboxEntry): Promise<boolean> {
  const resendKey = process.env.AEGIS_RESEND_API_KEY;
  const emailTo = process.env.AEGIS_EMAIL_TO;
  if (!resendKey || !emailTo) return false;
  try {
    const payload = parsePayload(entry);
    const label = HUMAN_LABELS[entry.eventType] ?? entry.eventType;
    const rows = Object.entries(payload)
      .map(([k, v]) => `<tr><td><b>${k}</b></td><td>${String(v)}</td></tr>`)
      .join("");
    const html = `
      <h2>${label}</h2>
      <p>AEGIS guard event on wallet <code>${entry.walletId}</code>:</p>
      <table border="0" cellpadding="6" style="border-collapse:collapse;font-family:monospace">
        ${rows}
      </table>`;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resendKey}`,
      },
      body: JSON.stringify({
        from: process.env.AEGIS_EMAIL_FROM ?? "AEGIS <alerts@aegis.local>",
        to: emailTo.split(",").map((s) => s.trim()),
        subject: `[AEGIS] ${label}`,
        html,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Delivers an outbox entry to every configured channel. Resolves the number
 * of successful deliveries — callers must never block on this.
 */
export async function deliverAlert(entry: OutboxEntry): Promise<number> {
  const results = await Promise.allSettled([
    deliverWebhook(entry),
    deliverSlack(entry),
    deliverEmail(entry),
  ]);
  return results.filter((r) => r.status === "fulfilled" && r.value === true).length;
}

async function deliverWebhook(entry: OutboxEntry): Promise<boolean> {
  const webhookUrl = process.env.AEGIS_WEBHOOK_URL;
  if (!webhookUrl) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(process.env.AEGIS_WEBHOOK_SECRET ? { "x-aegis-webhook": process.env.AEGIS_WEBHOOK_SECRET } : {}),
    };
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        event: entry.eventType,
        walletId: entry.walletId,
        payload: parsePayload(entry),
        createdAt: entry.createdAt,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

function parsePayload(entry: OutboxEntry): Record<string, unknown> {
  try {
    return JSON.parse(entry.payload) as Record<string, unknown>;
  } catch {
    return { raw: entry.payload };
  }
}
