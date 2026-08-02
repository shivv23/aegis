# AEGIS — Agent Wallet Kill Switch

**FinTech · Problem Statement 2 · INNOVA HACK Round 2**

> Enforcement lives in the wallet layer, not the agent's head.

**🚀 Live app: https://aegis-shivv23s-projects.vercel.app**

Autonomous agents hold wallets and transact unsupervised. A compromised,
buggy, or overzealous agent can spend faster than any human can react.
AEGIS is a wallet-layer enforcement system: spend limits, allowlisted
counterparties, and an owner-controlled kill switch that an agent cannot
read, modify, or bypass — because none of the controls live in the agent's
own logic.

## Live demo

Deployed on Vercel against a Neon PostgreSQL ledger (persistent, tamper-evident):

- **Dashboard:** https://aegis-shivv23s-projects.vercel.app
- **API (demo):** `GET /api/bootstrap` hands the UI the demo owner key; agent
  keys are minted per-wallet and Ed25519-signed transfers hit `POST /api/rail/transfer`
- **On-chain Guardian (Sepolia):** `Guardian` at
  `0xbdA598ffF1245E8cF147cfe3F99e4c49204C5343`, `PolicyRegistry` at
  `0x629Be710c67f666b7b3eFEB0c16831Ea28E0BEA1`. The active policy hash is
  sealed on-chain and equals the app's `policyHash()`; `GET /api/guardian`
  reports live limits + `matches: true` when the off-chain hash equals the seal.

---

## The thesis

Every money movement must pass through an independent **Policy Guard** at the
payment-rail layer. The agent is handed a **scoped key** that can call exactly
one thing — `POST /api/rail/transfer`. Limits, allowlist, and freeze state are
enforced by the wallet itself. Even a fully hostile agent is capped by
construction.

```
Agent (scoped key)  ──▶  POST /api/rail/transfer  ──▶  POLICY GUARD (pure code)
                                                            │ validate(tx)
                                                            ▼
                                                   LEDGER (append-only,
                                                   strict state machine)
                                                            ▲
 Owner (master key)  ──▶ freeze · revoke · edit policy ──────┘
```

## What it does

| Capability | Where | How |
|---|---|---|
| Per-tx cap | Guard | `amount > maxPerTx` → `LIMIT_EXCEEDED` |
| Daily / monthly limits | Guard | rolling windows, counts **settled + in-flight reserved** spend |
| Allowlist | Guard | only pre-approved counterparties can be paid |
| Velocity limit | Guard | caps tx/min even when each tx is individually legal |
| Kill switch | Wallet | owner freezes → all transfers blocked instantly, in-flight txs revoked |
| In-flight revocation | Wallet | transactions hold in `PENDING` for a window; owner can revoke mid-flight |
| Nonce replay protection | Rail | each transfer needs a unique nonce |
| Audit trail | Ledger | append-only, actor-stamped (agent / owner / system) |
| **Cryptographic agent identity** | Rail | agents sign transfers with an **Ed25519 keypair** (`x-aegis-*` headers); a stolen token is useless without the private key |
| **Tamper-evident ledger** | Ledger | every row is **hash-chained** (`prev_hash`+`hash`+global `seq`); `GET /api/ledger/verify` proves integrity |
| **Policy versioning + timelock** | Wallet | limit changes are recorded as versions and take effect after `AEGIS_POLICY_TIMELOCK_MS` |
| **Ops alert outbox** | Wallet | every guard decision and wallet event is queued for delivery — HMAC-signed webhooks + a live in-app outbox carrying one-tap approve/decline deep links; Slack/email transports slot in when their env keys are set |
| **Risk engine** | Rail | pre-tx score 0–100 (amount vs cap/budget, new payee, velocity burst, red-flag purpose, hour) |
| **Step-up approval** | Wallet | risk score ≥ 55 → `STEP_UP_REQUIRED`; owner approves/declines before it may settle |
| **Auto-freeze circuit breaker** | Wallet | N guard anomalies in a window → wallet freezes itself (`AEGIS_BREAKER_*`) |
| **Pluggable settlement rails** | Rail | settlement routes through a rail plugin (`sandbox` / `usdc-testnet` / `ach-lite`) — the guard never changes |
| **2-of-3 multi-sig owners** | Keys | owner control-plane keys are minted only after 2 distinct signers approve; signers must be registered first (demo seeds 2, a third can be added from the console) |
| **Multi-tenant orgs** | Keys | orgs with per-org wallets, org-scoped owner keys and auth on wallet routes |
| **Spending windows + geo** | Guard | policy can restrict transfers to UTC hours (`spendingWindows`) and to approved regions (`regionAllowlist`); a `x-aegis-region` header carries the region claim |
| **Counterparty registry** | Guard | counterparties carry status/flags/reputation; `BLOCKED` counterparties are rejected before any other check |
| **Sanctions screening (OFAC-lite)** | Guard | a watchlist matcher runs before any money moves — a hit blocks with `SANCTIONED` regardless of allowlist, and registering a sanctioned payee auto-blocks + stamps it |
| **Read-only auditor role** | Keys | `scope: auditor` keys can inspect ledger/audit/outbox/export/guardian but every mutating route still requires `owner` — separation of duties |
| **Security events feed** | Ops | `/api/security` + UI: a SIEM-lite feed of failed auth (invalid/revoked/unauthorized) and sensitive actions (admin, freeze, policy, key, signer) |
| **Budget groups** | Guard | cross-wallet monthly caps — the whole fleet is bound by one org budget, not just a single wallet |
| **Conditional escrows** | Wallet | funds are debited into an escrow and released only when a condition is met (or refunded back) |
| **Usage metering** | Wallet | per-wallet usage rows + totals and per-rail breakdown for billing |
| **Multi-currency display** | Ledger | render any balance/amount in USD, USDC, EUR, INR, or ETH (single-unit ledger truth) |
| **Regulator export** | Export | one-click audit pack (`audit.csv`, `auditlog.csv`, `audit.json`) + a SAR-lite monthly report flagging counterparty anomalies |
| **Agent key lifecycle** | Keys | list, rotate, revoke, expire, and ACL agent keys — a rotated key dies the moment the owner rotates it |
| **LLM intent classifier** | Rail | optional (`AEGIS_LLM_URL` + `AEGIS_LLM_KEY`) classification of the `purpose` field; when the LLM's intent contradicts the claimed intent, risk is bumped (`intent_anomaly`) and an `INTENT_ANOMALY` audit row is written — deterministic heuristic fallback, never gates a transfer on its own |
| **Push alert webhooks** | Wallet | every outbox event is POSTed to `AEGIS_WEBHOOK_URL` (HMAC-signed with `AEGIS_WEBHOOK_SECRET`) |
| **What-if policy simulator** | Sim | replay a wallet's real history against a hypothetical policy and see every would-be block |
| **On-chain mirror** | Chain | `Guardian.sol` runs the same checks; `PolicyRegistry.sol` seals the active policy hash (live on Sepolia, verified `matches: true`) |
| **Batch payroll + recurring** | Rail | one CSV/row batch through the same guard; recurring schedules run on cron and re-check policy at execution time |
| **Simulated funding rails** | Rail | deposit/withdraw credit & debit the same hash-chained ledger with bank-style refs, explicitly `simulated:true` — no real money moves |
| **Signed export proof** | Export | every `audit.json` pack carries a deterministic Ed25519 signature + ledger head hash; anyone can verify offline with the published public key |
| **Per-tx timeline + latency** | Ops | every hop (requested → hold → settled/blocked/revoked) from real stored timestamps, plus p50/p95 processing metrics |
| **Structuring / smurfing detection** | Ops | flags clusters of many small same-beneficiary payments that jointly breach a cap (AML-lite alert, never a block) |
| **Alert acknowledgement** | Ops | threshold/structuring alerts are acked with who + why, and the ack is itself audited |
| **Step-up escalation** | Ops | undecided high-risk transfers within their grace window get a nudge event so they never silently expire |
| **Hardware-key (WebAuthn) approval** | Keys | register a passkey from the wallet console; high-risk transfers can be approved with physical presence instead of a copied token |
| **Scoped keys with actions + TTL** | Keys | minted keys can carry per-key action families (freeze/policy/audit) and an absolute expiry; a key with `actions` can only perform those |
| **Saved searches** | Ops | persist transaction filters across sessions (`/api/searches`) |
| **Chaos lab** | Ops | one-click load mix (valid / chaos / velocity) against the real rail with funnel + latency + breaker telemetry |

## Stack

- **Next.js 16 (App Router)** + **TypeScript (strict)** — API routes are the payment rail
- **Tailwind CSS 4** + lucide-react — terminal-styled dashboard
- **libSQL / PostgreSQL** (`src/core/db.ts`) — persistent, append-only ledger.
  Runs on libSQL (SQLite) by default; point `AEGIS_DB_URL` at a Postgres
  connection string to scale — no code changes.
- **Zod** — runtime validation at every API boundary
- **jose (JWT/HMAC)** — owner control-plane keys
- **Ed25519 (node:crypto)** — agent keypairs sign every transfer request
- **SHA-256 hash chain** — tamper-evident, append-only ledger
- **SSE** — live transaction stream to the dashboard
- **Vitest** — 299 tests across 40 suites incl. attack-resistance, signing, ledger, timelock, risk, step-up, breaker, simulator, rail, multi-sig, orgs, on-chain mirror, counterparties, budget groups, escrows, usage, multi-currency, export, key lifecycle, LLM classifier, round-2 (batches, recurring, funding, structuring, thresholds, passkeys, escalation, export proof, timeline), and property-based fuzzing of the guard (fast-check)
- **Solidity (Hardhat)** — `contracts/`: on-chain `Guardian` (per-tx cap, allowlist, daily/velocity limits, one-way `revoke()`) + `PolicyRegistry` (seals the policy hash) — 10 Hardhat tests green; live on Sepolia

## Getting started

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # policy guard + attack-resistance + SDK suites
npm run sim        # CLI agent simulator, built on the SDK
npm run typecheck

# on-chain mirror (optional, no network needed)
cd contracts && npm install && npx hardhat test
cd contracts && npx hardhat run scripts/deploy.ts   # deploy + seal locally

# real Sepolia deployment (needs a funded testnet key)
$env:AEGIS_DEPLOYER_KEY="0x..."            # funded Sepolia private key
$env:AEGIS_RPC_URL="https://ethereum-sepolia-rpc.publicnode.com"   # optional
cd contracts && npx hardhat run scripts/deploy.ts --network sepolia
# writes contracts/deployments/sepolia.json + prints the Vercel env vars to set
```

First run seeds a demo wallet (`TradingBot-42`, daily limit $1000, 3
allowlisted vendors) so the dashboard is alive immediately.

## SDK — the only thing an agent should ever hold

```ts
import { Aegis } from "@/lib/sdk";

const agent = new Aegis({
  baseUrl: "https://aegis-shivv23s-projects.vercel.app",
  walletId: "wallet-tradingbot-42",
  privateKey: process.env.AGENT_PRIVATE_KEY, // Ed25519 pkcs8 (base64url)
});

const r = await agent.transfer({ to: "compute:0xCAFE0001", amount: 30, purpose: "GPU burst" });
// { ok: true, status: 201, body: { status: "PENDING", ... } }
```

- Every transfer is **Ed25519-signed** — the agent *is* its keypair; a leaked
  bearer token is worthless without the private key.
- Also exposes `mintAgentKey`, `scopedKeys`, `createWallet`, `freeze`,
  `unfreeze`, `patchPolicy`, `revoke`, `stepUp`, `verifyLedger`, `rails`,
  `guardian`, `breaker`, multi-sig signer/approval flows, **multi-tenant
  orgs** (`createOrg`, `listOrgs`, `getOrg`), **counterparties**,
  **budget groups**, **escrows** (`createEscrow`, `releaseEscrow`,
  `refundEscrow`), **usage**, **currencies**, **regulator export**
  (`exportAuditCsv`, `sarReport`), and **key lifecycle** (`listAgentKeys`,
  `revokeAgentKey`, `rotateAgentKey`) — see `src/lib/sdk.ts`
  (+ `sdk.test.ts`).
- A **Python SDK** (`python/aegis/sdk.py`) mirrors the TypeScript API for
  agent stacks in Python — `python/tests/test_sdk.py`,
  `python/examples/agent_demo.py` (hostile-agent demo).
- `scripts/agent-sim.ts` runs the hostile-agent demo through the SDK.

## Product pages

- **Home** (`/home`) — marketing landing: product, pricing, proof
- **Command Center** (`/`) — live SSE feed, kill switch, wallet registry
- **Settlement Explorer** (`/explorer`) — every settled transfer's reference rendered as a trace, honestly labeled (in-process / mock bank / on-chain-style)
- **Security Events** (`/security`) — SIEM-lite feed: failed auth + sensitive actions, curated from the request audit
- **Agent Simulator** (`/simulator`) — hostile-agent attack presets against the real rail
- **Policy Sandbox** (`/sandbox`) — one-click what-if scenarios
- **Multi-sig** (`/multisig`) — 2-of-3 signer approval console (seed demo has 2 registered signers; add a third to watch the flow)
- **Analytics** (`/analytics`) — guard funnel, blocked-reason chart, daily spend, by-purpose
- **API Docs** (`/docs`) — human-readable reference + `GET /api/openapi` (OpenAPI 3.0)
- **Whitepaper** (`/whitepaper`) — threat model, defense-in-depth, attack matrix, test matrix

## API

All endpoints require `Authorization: Bearer <key>`.### Agent rail — the only thing an agent can do
| Method | Path | Key | Purpose |
|---|---|---|---|
| `POST` | `/api/rail/transfer` | agent | Request a transfer. Guard decides. |
| `GET` | `/api/rail/health` | agent/owner | Verify scoped identity |
| `POST` | `/api/rail/batch` | agent | Batch transfers (rows or array) through the same guard |
| `GET/POST` | `/api/rail/recurring` | owner | List / create recurring schedules (runs on cron, re-checked at execution) |
| `GET` | `/api/cron/jobs` | system | Scheduled jobs: settle due txs, step-up expiry + escalation, breaker reset, recurring run, ledger verify, SAR digest |
| `POST` | `/api/rail/recurring/run` | system | Cron hook: runs only the due recurring payments |
| `POST` | `/api/rail/fund` | owner | Simulated deposit: credits the ledger with a bank-style ref (`simulated:true`) |
| `POST` | `/api/rail/withdraw` | owner | Simulated withdrawal: debits the ledger with a bank-style ref |

### Owner control plane
| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/wallet` | Provision wallet + policy, returns agent & owner keys |
| `GET` | `/api/wallet` | List wallets |
| `GET`/`PATCH` | `/api/wallet/:id` | View / edit policy (timelocked) |
| `POST` | `/api/wallet/:id/freeze` | **Engage kill switch** |
| `POST` | `/api/wallet/:id/unfreeze` | Release kill switch |
| `POST` | `/api/transactions/:id/revoke` | Revoke an in-flight transaction |
| `POST` | `/api/transactions/:id/stepup` | Owner decision on a high-risk transfer (`approve`/`decline`) |
| `GET` | `/api/breaker` | Circuit-breaker state per wallet |
| `POST` | `/api/simulate` | What-if: replay a wallet&apos;s real history against a hypothetical policy |
| `GET` | `/api/rails` | Active settlement rail + available rails |
| `GET` | `/api/security` | Security events feed (failed auth + sensitive actions) |
| `GET` | `/api/guardian` | On-chain mirror: addresses, **live** paused/limits, sealed policy hash + match proof |
| `GET/POST` | `/api/orgs` | List / create multi-tenant organizations |
| `GET` | `/api/orgs/:id` | Organization + its wallets |
| `GET/POST` | `/api/signers` | List / register multi-sig signers (register is master-key only) |
| `DELETE` | `/api/signers/:id` | Remove a signer (master key only) |
| `GET/POST` | `/api/approvals` | List / propose an owner-key issuance (2-of-3) |
| `POST` | `/api/approvals/:id/approve` | A signer approves; the minted key is returned at threshold |
| `POST` | `/api/approvals/:id/reject` | A signer vetoes the issuance |
| `GET` | `/api/transactions` | Ledger view |
| `GET` | `/api/transactions/stream` | SSE live feed |
| `GET` | `/api/audit` | Audit trail |
| `GET` | `/api/keys?walletId=` | Mint scoped owner/agent JWT keys + list agent keys (lifecycle); `?role=auditor` mints a read-only auditor key |
| `POST` | `/api/keys/mint` | Mint an **Ed25519 agent keypair** (signed identity); `?scope=` with `actions[]` (freeze/policy/audit) and `ttl` for action-scoped owner keys |
| `POST` | `/api/keys/revoke` | Revoke an agent Ed25519 public key |
| `POST` | `/api/keys/rotate` | Rotate: revoke old key + return a fresh keypair |
| `POST` | `/api/keys/verify` | Verify an Ed25519 signature offline (public key + message + signature) |
| `GET/POST` | `/api/passkey/register` | Begin / verify hardware-key (WebAuthn) registration |
| `GET/POST` | `/api/passkey/assert` | Begin / verify hardware-key assertion for step-up approval |
| `GET/POST` | `/api/searches` | List / save persisted transaction searches |
| `DELETE` | `/api/searches/:id` | Delete a saved search |
| `GET/POST` | `/api/counterparties` | List / upsert counterparty registry (BLOCKED stops transfers; sanctions hits auto-block) |
| `GET/POST` | `/api/budget-groups` | List (`?walletId=` resolves group) / create cross-wallet budget groups |
| `GET/POST/PATCH` | `/api/escrows` | List / create escrow / release or refund (`?id=&action=release\|refund`) |
| `GET` | `/api/usage` | Usage metering: rows, totals, per-rail breakdown |
| `GET` | `/api/currencies` | Supported display currencies |
| `GET` | `/api/export` | Regulator pack: `?kind=audit.csv \| auditlog.csv \| audit.json \| report`; `audit.json` is signed (Ed25519) and `?kind=verify` checks the signature + ledger head |
| `GET` | `/api/ledger/verify` | Prove the hash chain is intact |
| `GET` | `/api/outbox` | Ops alert feed (guard decisions + wallet events) |
| `POST` | `/api/outbox/:id/ack` | Acknowledge an alert with who + why (acked by owner/agent, audited) |
| `GET` | `/api/transactions/:id/timeline` | Per-tx lifecycle hops from stored timestamps + latency percentiles |
| `GET` | `/api/chaos` | Chaos-lab presets (valid / chaos / velocity mix) with funnel + latency + breaker telemetry |
| `POST` | `/api/admin/reset` | Reset demo data (demo mode) |
| `GET` | `/api/bootstrap` | Demo: hands the UI the master owner key |

### Transfer lifecycle

```
request → guard(validate) ──┬─ allow → PENDING (hold window)
                            └─ deny  → BLOCKED (reason recorded, audit logged)

PENDING ── hold expires & wallet ACTIVE  ──▶ SETTLED (balance debited)
PENDING ── owner revokes / wallet frozen ──▶ REVOKED (IN_FLIGHT_REVOKED)
```

## Security model

1. **Least privilege.** Agent keys carry `scope: agent` and a single wallet
   ID. They can only reach the rail. Owner keys (`scope: owner`) control
   policy, freeze, and revocation. The master owner key (`*`) manages all.
2. **Cryptographic agent identity.** Agents mint an Ed25519 keypair and sign
   every transfer (`x-aegis-wallet`, `x-aegis-timestamp`, `x-aegis-signature`).
   The rail verifies signature + freshness + replay nonce before the guard
   runs. A stolen bearer token is useless without the private key.
3. **Guard is code, not data.** Policy *values* change at runtime; enforcement
   *logic* cannot. There is no code path an agent can reach to weaken a rule.
4. **Reservation on approval.** In-flight transfers count against limits
   immediately, so splitting a payment under the per-tx cap can't beat the
   daily cap (covered by tests).
5. **Replay protection.** Every transfer needs a fresh nonce.
6. **Tamper-evident ledger.** Every transaction and audit row is hash-chained
   (SHA-256 over immutable content + previous hash). `GET /api/ledger/verify`
   walks the chain and flags any edit, swap, or deletion.
7. **Timelocked policy.** Policy changes are recorded as versions and only
   become effective after `AEGIS_POLICY_TIMELOCK_MS` — a stolen owner key
   can't instantly weaken the guard.
8. **Append-only ledger.** Nothing is edited, only transitioned; the state
   machine rejects illegal transitions (`SETTLED → REVOKED` throws).
9. **Risk-scored, human-in-the-loop.** Even a fully policy-compliant transfer
   is scored 0–100. High-risk → `STEP_UP_REQUIRED`; the owner must approve
   before it enters the settlement window. Critical risk is rejected outright.
10. **Self-defending.** The circuit breaker counts guard anomalies and
    auto-freezes a wallet that looks compromised before a human notices.
11. **On-chain mirror.** The same checks run in `contracts/Guardian.sol`; the
    active policy hash is sealed in `contracts/PolicyRegistry.sol` — a
    compromised server can't silently rewrite the limits. `revoke()` on-chain
    is one-way: no agent, and no stolen key, can un-freeze it.
12. **Multi-sig owner issuance.** Owner keys — the only credential that can
    change policy or trigger the kill switch — are issued 2-of-3. The demo
    mints them deterministically per signer; approval requires two distinct
    signers, and duplicate votes are rejected.

## Demo script (5 minutes)

1. Open **Command Center** — live feed shows the seeded wallet's history.
2. Open **TradingBot-42** → mint the agent key → arm the simulator.
3. Fire a **legit payment** → `PENDING → SETTLED` in ~5s.
4. Fire **"Over per-tx limit"** → `BLOCKED LIMIT_EXCEEDED`.
5. Fire **"Non-allowlisted payee"** → `BLOCKED NOT_ALLOWLISTED`.
6. **Burst ×35** → velocity limit blocks the surplus.
7. Fire **"Large legit (in-flight window)"**, then hit **Revoke** while it
   holds → `REVOKED IN_FLIGHT_REVOKED`. *(the bonus metric)*
8. Hit **ENGAGE KILL SWITCH** → everything instant-blocks, pending txs revoke.
9. **Release** → wallet resumes. Every move is in the **Audit Trail**.
10. From **Agent Simulator**, run the attack presets against the real API and
    show the raw JSON responses.

## Project structure

```
src/
  core/            # enforcement heart (framework-free, fully tested)
    guard.ts       #   pure policy engine — the single choke point
    risk.ts        #   deterministic pre-tx risk scoring (0–100)
    simulate.ts    #   what-if policy replay (read-only)
    stateMachine.ts#   tx status transitions
    signing.ts     #   Ed25519 agent keypairs: sign/verify/canonical message
    ledger.ts      #   SHA-256 hash chain: append, verify, rechain
    keys.ts        #   owner JWT signing/verification
    db.ts          #   libSQL / PostgreSQL adapter (env-var switch)
    store.ts       #   ledger, outbox, policy versions, agent keys, breaker,
                   #   counterparties, budget groups, escrows, usage
    currency.ts    #   multi-currency display (USD/USDC/EUR/INR/ETH)
    classify.ts    #   LLM intent classifier + heuristic fallback
    push.ts        #   webhook push-alert delivery
    export.ts      #   regulator audit pack + SAR-lite report
    seed.ts        #   demo constants
    guard.test.ts / signing.test.ts / ledger.test.ts / policy.test.ts /
    risk.test.ts / stepup.test.ts / simulate.test.ts / rails.test.ts /
    multisig.test.ts / orgs.test.ts / chain.test.ts / features.test.ts /
    guard-extensions.test.ts / currency.test.ts / export.test.ts /
    classify.test.ts
    test-env.ts    #   in-memory DB env for tests
  core/chain.ts    #   raw JSON-RPC reader of the deployed Guardian/PolicyRegistry
  app/api/         # payment rail + owner control plane (Route Handlers)
  app/*.tsx        # Command Center, Wallet Registry, Wallet detail,
                   # Transactions, Audit, Agent Simulator
  components/      # dashboard + simulator console + ledger badge + key lifecycle
  hooks/use-stream.ts  # SSE client
  app/multisig/     # 2-of-3 signer approval console
  app/sandbox/      # public playground with one-click attack scenarios
  app/simulator/    # what-if policy simulator UI
  app/analytics/    # guard telemetry console
  app/docs/         # OpenAPI docs
  app/whitepaper/   # security whitepaper (threat model + attack matrix + tests)
  app/(marketing)/home/  # landing + marketing site (pricing)
  contracts/        # Hardhat: Guardian.sol + PolicyRegistry.sol (on-chain mirror)
  contracts/deployments/sepolia.json  # live deployment artifact (git-ignored)
scripts/agent-sim.ts  # standalone CLI agent (signed or JWT) that attacks the real rail
```

## Environment

| Variable | Default | Notes |
|---|---|---|
| `AEGIS_SECRET` | dev secret | HMAC secret for owner keys — **set in prod** |
| `AEGIS_DB_URL` | `file:./data/aegis.db` | libSQL file, a Turso `libsql://` URL, **or a `postgres://` URL** to run on PostgreSQL |
| `AEGIS_HOLD_MS` | `5000` | in-flight revocation window |
| `AEGIS_POLICY_TIMELOCK_MS` | `0` (demo) / `300000` (prod) | policy changes take effect after this delay |
| `AEGIS_SIGNATURE_SKEW_MS` | `300000` | max age of a signed agent request |
| `AEGIS_STEPUP_TTL_MS` | `120000` | how long an owner has to decide on a high-risk transfer |
| `AEGIS_BREAKER_THRESHOLD` | `5` | anomalies within the window that auto-freeze a wallet |
| `AEGIS_BREAKER_WINDOW_MS` | `60000` | circuit-breaker observation window |
| `AEGIS_RAIL` | `sandbox` | active settlement rail: `sandbox`, `usdc-testnet`, or `ach-lite` |
| `AEGIS_USDC_RAIL_URL` | unset | optional gateway URL for real USDC settlement |
| `AEGIS_MULTISIG_REQUIRED` | `2` | distinct signers needed to mint an owner key (2-of-3) |
| `AEGIS_MULTISIG_TTL_MS` | `600000` | how long an open approval stays valid |
| `AEGIS_GUARDIAN_ADDRESS` | unset | deployed `Guardian` address (shown on `/api/guardian`) |
| `AEGIS_POLICY_REGISTRY` | unset | deployed `PolicyRegistry` address |
| `AEGIS_RPC_URL` | unset | chain RPC for the on-chain mirror |
| `AEGIS_CHAIN_NAME` | `hardhat (local)` | label for the sealed-policy explorer link |
| `AEGIS_DEMO_MODE` | `1` | set `0` to disable bootstrap/reset |
| `AEGIS_DEPLOYER_KEY` | unset | funded Sepolia private key for `hardhat run --network sepolia` |
| `AEGIS_ETHERSCAN_KEY` | unset | optional; enables contract verification on Sepolia |
| `AEGIS_WEBHOOK_URL` | unset | ops push-alert webhook: every outbox event is POSTed here |
| `AEGIS_WEBHOOK_SECRET` | unset | HMAC secret for `X-AEGIS-Signature` on webhook payloads |
| `AEGIS_LLM_URL` | unset | optional LLM endpoint for intent classification of `purpose` (OpenAI chat/completions dialect — works with OpenAI, Orca Router, OpenRouter) |
| `AEGIS_LLM_KEY` | unset | bearer key sent to `AEGIS_LLM_URL`; without it the request goes out unauthenticated |
| `AEGIS_LLM_MODEL` | `orcarouter/auto` | model id sent to the LLM endpoint |
| `AEGIS_ESCALATION_GRACE_MS` | `30000` | step-up window after which undecided transfers get an escalation nudge event |
| `AEGIS_EXPORT_SIGNING_KEY` | generated | Ed25519 seed used to sign `audit.json` export packs; set a fixed value so prod signatures stay verifiable |

The database is swappable via the adapter in `src/core/db.ts`. Set
`AEGIS_DB_URL=postgres://user:pass@host:5432/db` and the ledger runs on
PostgreSQL with zero code changes (`?` placeholders are translated to `$n`).
Migration steps: create the three tables (SQL is emitted on startup via
`CREATE TABLE IF NOT EXISTS`), then set the env var.

## Demo hygiene for submission

- Reset demo data before recording (`Reset demo` in Command Center).
- Already deployed on Vercel with `AEGIS_DB_URL` pointed at Neon PostgreSQL.
- GitHub collaborators added before the deadline.
- **No commits after 2 Aug 2026, 6:00 PM IST.**
