import type { NextRequest } from "next/server";
import { error, json } from "@/core/api";
import { emailConfigured, magicLinkFor, signMagicToken } from "@/core/auth";
import { sendMagicLinkEmail } from "@/core/push";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST /api/auth/magic-link/request  {email}
 * Issues a one-time magic link. When Resend is configured the link is emailed;
 * otherwise (dev/demo) the link is returned so the flow stays demo-able.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email)) return error("A valid email is required", 400);

  const token = await signMagicToken(email);
  const link = magicLinkFor(token);

  if (emailConfigured()) {
    await sendMagicLinkEmail(email, link);
    return json({ ok: true, sent: true, email });
  }
  return json({ ok: true, sent: false, devLink: link, email });
}
