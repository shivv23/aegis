import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { checkRateLimit } from "@/core/ratelimit";

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Zero-trust gateway: every /api request is rate limited per key and per IP
 * (token bucket) before it reaches a handler. 429s carry Retry-After so
 * well-behaved agents back off instead of hammering.
 */
export default async function proxy(req: NextRequest) {
  const fwd = req.headers.get("x-forwarded-for");
  const ip = fwd?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";

  const auth = req.headers.get("authorization");
  let keyHash: string | undefined;
  if (auth?.startsWith("Bearer ")) {
    keyHash = await sha256Hex(auth.slice(7).trim());
  }

  const { key, ip: ipResult } = checkRateLimit({ keyHash, ip });
  if (!ipResult.ok || !key.ok) {
    const resetInMs = Math.max(ipResult.resetInMs, key.resetInMs);
    const reason = !key.ok ? "key" : "ip";
    return NextResponse.json(
      { error: "Rate limit exceeded", scope: reason, limit: key.limit },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(resetInMs / 1000)) },
      },
    );
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};
