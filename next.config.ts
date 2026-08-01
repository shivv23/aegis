import type { NextConfig } from "next";

/**
 * B5 — production hygiene: a CORS allowlist for the API, security headers on
 * every response, and a lightweight CSP. The AEGIS API is key-authenticated;
 * CORS only matters for browser callers, so default to deny.
 */
const corsOrigins = (process.env.AEGIS_CORS_ORIGINS ?? "https://aegis-shivv23s-projects.vercel.app")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "X-XSS-Protection", value: "1; mode=block" },
  {
    key: "Content-Security-Policy",
    value:
      "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net; " +
      "style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://aegis-shivv23s-projects.vercel.app; font-src 'self' data:; frame-ancestors 'none'",
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    const apiCors = corsOrigins.map((origin) => ({
      source: "/api/:path*",
      headers: [
        { key: "Access-Control-Allow-Origin", value: origin },
        { key: "Access-Control-Allow-Methods", value: "GET, POST, PUT, PATCH, DELETE, OPTIONS" },
        { key: "Access-Control-Allow-Headers", value: "Authorization, Content-Type, Idempotency-Key, x-aegis-signature, x-aegis-wallet, x-aegis-timestamp, x-aegis-region, x-vercel-cron" },
        { key: "Access-Control-Allow-Credentials", value: "true" },
        { key: "Access-Control-Max-Age", value: "86400" },
      ],
    }));
    const global = [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
    return [...global, ...apiCors];
  },
};

export default nextConfig;
