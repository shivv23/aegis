import { json } from "@/core/api";

const spec = {
  openapi: "3.0.3",
  info: {
    title: "AEGIS — Agent Wallet Kill Switch",
    version: "0.1.0",
    description:
      "Wallet-layer enforcement for autonomous agents. Every money movement passes through an independent Policy Guard; the agent is handed a scoped key that can call exactly one thing: POST /api/rail/transfer.",
  },
  servers: [{ url: "/" }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description: "Owner control-plane JWT or legacy agent JWT.",
      },
      signedAgent: {
        type: "apiKey",
        in: "header",
        name: "x-aegis-signature",
        description: "Ed25519 signature over the canonical transfer message (preferred).",
      },
    },
  },
  paths: {
    "/api/rail/transfer": {
      post: {
        summary: "Request a transfer (the ONLY action an agent can take).",
        description:
          "Authenticate via Ed25519 signature (x-aegis-wallet / x-aegis-timestamp / x-aegis-signature) or bearer JWT. The guard decides: allow → PENDING (hold window), deny → BLOCKED.",
        security: [{ signedAgent: [], bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["to", "amount", "nonce"],
                properties: {
                  to: { type: "string", example: "compute:0xCAFE0001" },
                  amount: { type: "number", example: 30 },
                  purpose: { type: "string", example: "GPU burst" },
                  nonce: { type: "string", description: "Unique; replay protection." },
                },
              },
            },
          },
        },
        responses: {
          201: { description: "PENDING — accepted into the in-flight hold window." },
          400: { description: "Invalid payload." },
          403: { description: "Blocked by the guard: LIMIT_EXCEEDED, NOT_ALLOWLISTED, VELOCITY_EXCEEDED, DAILY_LIMIT_EXCEEDED, WALLET_FROZEN, etc." },
          401: { description: "Signature/JWT rejected." },
        },
      },
    },
    "/api/rail/health": { get: { summary: "Verify scoped agent identity." } },
    "/api/wallet": {
      post: { summary: "Provision a wallet + policy; returns owner & agent keys." },
      get: { summary: "List wallets." },
    },
    "/api/wallet/{id}": {
      get: { summary: "View wallet + active policy." },
      patch: { summary: "Edit policy (timelocked)." },
    },
    "/api/orgs": {
      get: { summary: "List organizations (multi-tenant workspaces)." },
      post: { summary: "Create an organization." },
    },
    "/api/orgs/{id}": {
      get: { summary: "View an organization + its wallets." },
    },
    "/api/wallet/{id}/freeze": { post: { summary: "Engage the kill switch." } },
    "/api/wallet/{id}/unfreeze": { post: { summary: "Release the kill switch." } },
    "/api/transactions": {
      get: { summary: "Ledger view (cursor-paginated).", description: "?walletId=&limit=&cursor= — keyset pages; pass nextCursor from the response to continue. Newest first." },
    },
    "/api/transactions/{id}/revoke": { post: { summary: "Revoke an in-flight transaction." } },
    "/api/transactions/{id}/stepup": {
      post: { summary: "Owner decision on a high-risk transfer (approve/decline)." },
    },
    "/api/transactions/stream": { get: { summary: "SSE live feed." } },
    "/api/keys": { get: { summary: "Mint scoped owner/agent JWT keys (master key), or list agent keys + lifecycle for a wallet." } },
    "/api/keys/mint": {
      post: { summary: "Mint an Ed25519 agent keypair — the agent's identity." },
    },
    "/api/keys/revoke": {
      post: { summary: "Revoke an agent Ed25519 public key (rotates it out of the allowlist)." },
    },
    "/api/keys/rotate": {
      post: { summary: "Rotate: revoke the old key, mint a fresh keypair, return the new private key." },
    },
    "/api/counterparties": {
      get: { summary: "List counterparty registry (reputation, totals, flags)." },
      post: { summary: "Upsert a counterparty (ACTIVE/FLAGGED/BLOCKED); BLOCKED stops all transfers to it." },
    },
    "/api/budget-groups": {
      get: { summary: "List budget groups; ?walletId resolves the group for a wallet." },
      post: { summary: "Create a cross-wallet budget group with a monthly cap." },
    },
    "/api/escrows": {
      get: { summary: "List escrows; ?walletId filters." },
      post: { summary: "Create an escrow — funds are debited and held until a condition releases them." },
      patch: { summary: "PATCH ?id=<escrowId>&action=release|refund — settle or return the held funds." },
    },
    "/api/usage": {
      get: { summary: "Usage metering per wallet (rows, totals, per-rail breakdown).", description: "?walletId=&limit=&cursor= — cursor-paginated." },
    },
    "/api/currencies": {
      get: { summary: "Supported display currencies (USD, USDC, EUR, INR, ETH)." },
    },
    "/api/export": {
      get: {
        summary: "Regulator export pack.",
        description: "?kind=audit.csv | auditlog.csv | audit.json (flat pack) | report (SAR-lite monthly JSON).",
      },
    },
    "/api/ledger/verify": { get: { summary: "Prove the hash chain is intact." } },
    "/api/audit": { get: { summary: "Audit trail (cursor-paginated).", description: "?walletId=&limit=&cursor= — keyset pages, newest first." } },
    "/api/outbox": { get: { summary: "Ops alert feed (guard decisions + wallet events), cursor-paginated.", description: "?walletId=&limit=&cursor=" } },
    "/api/breaker": { get: { summary: "Circuit-breaker state per wallet." } },
    "/api/simulate": { post: { summary: "What-if: replay history against a hypothetical policy." } },
    "/api/rails": { get: { summary: "Active settlement rail + available rails." } },
    "/api/security": { get: { summary: "Security events feed: failed auth + sensitive actions, curated from the request audit.", description: "?limit= (default 200, max 500) — auditor and owner can read." } },
    "/api/guardian": { get: { summary: "On-chain mirror: Guardian/PolicyRegistry addresses, live contract state (paused/limits) and the sealed policy hash with match proof." } },
    "/api/signers": {
      get: { summary: "List multi-sig signers." },
      post: { summary: "Register a signer (master key only)." },
    },
    "/api/signers/{id}": { delete: { summary: "Remove a signer (master key only)." } },
    "/api/approvals": {
      get: { summary: "List owner-key issuance approvals." },
      post: { summary: "Propose an issuance (2-of-3)." },
    },
    "/api/approvals/{id}/approve": { post: { summary: "A signer approves; the minted key is returned at threshold." } },
    "/api/approvals/{id}/reject": { post: { summary: "A signer vetoes the issuance." } },
    "/api/admin/reset": { post: { summary: "Reset demo data (demo mode)." } },
    "/api/bootstrap": { get: { summary: "Demo: hand the UI the master owner key." } },
  },
} as const;

export async function GET() {
  return json(spec);
}
