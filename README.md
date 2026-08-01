# AEGIS — Agent Wallet Kill Switch

**FinTech · Problem Statement 2 · INNOVA HACK Round 2**

> Enforcement lives in the wallet layer, not the agent's head.

Autonomous agents hold wallets and transact unsupervised. A compromised,
buggy, or overzealous agent can spend faster than any human can react.
AEGIS is a wallet-layer enforcement system: spend limits, allowlisted
counterparties, and an owner-controlled kill switch that an agent cannot
read, modify, or bypass — because none of the controls live in the agent's
own logic.

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
| **Ops alert outbox** | Wallet | every guard decision and wallet event is queued for delivery (SSE + future webhooks) |
| **Risk engine** | Rail | pre-tx score 0–100 (amount vs cap/budget, new payee, velocity burst, red-flag purpose, hour) |
| **Step-up approval** | Wallet | risk score ≥ 55 → `STEP_UP_REQUIRED`; owner approves/declines before it may settle |
| **Auto-freeze circuit breaker** | Wallet | N guard anomalies in a window → wallet freezes itself (`AEGIS_BREAKER_*`) |

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
- **Vitest** — 53 tests incl. attack-resistance, signing, ledger, timelock, risk, step-up, breaker suites

## Getting started

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # policy guard + attack-resistance suite
npm run sim        # CLI agent simulator (needs AGENT_KEY env)
npm run typecheck
```

First run seeds a demo wallet (`TradingBot-42`, daily limit $1000, 3
allowlisted vendors) so the dashboard is alive immediately.

## API

All endpoints require `Authorization: Bearer <key>`.

### Agent rail — the only thing an agent can do
| Method | Path | Key | Purpose |
|---|---|---|---|
| `POST` | `/api/rail/transfer` | agent | Request a transfer. Guard decides. |
| `GET` | `/api/rail/health` | agent/owner | Verify scoped identity |

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
| `GET` | `/api/transactions` | Ledger view |
| `GET` | `/api/transactions/stream` | SSE live feed |
| `GET` | `/api/audit` | Audit trail |
| `GET` | `/api/keys?walletId=` | Mint scoped owner/agent JWT keys |
| `POST` | `/api/keys/mint` | Mint an **Ed25519 agent keypair** (signed identity) |
| `GET` | `/api/ledger/verify` | Prove the hash chain is intact |
| `GET` | `/api/outbox` | Ops alert feed (guard decisions + wallet events) |
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
    stateMachine.ts#   tx status transitions
    signing.ts     #   Ed25519 agent keypairs: sign/verify/canonical message
    ledger.ts      #   SHA-256 hash chain: append, verify, rechain
    keys.ts        #   owner JWT signing/verification
    db.ts          #   libSQL / PostgreSQL adapter (env-var switch)
    store.ts       #   ledger, outbox, policy versions, agent keys, breaker
    seed.ts        #   demo constants
    guard.test.ts / signing.test.ts / ledger.test.ts / policy.test.ts /
    risk.test.ts / stepup.test.ts
    test-env.ts    #   in-memory DB env for tests
  app/api/         # payment rail + owner control plane (Route Handlers)
  app/*.tsx        # Command Center, Wallet Registry, Wallet detail,
                   # Transactions, Audit, Agent Simulator
  components/      # dashboard + simulator console + ledger badge
  hooks/use-stream.ts  # SSE client
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
| `AEGIS_DEMO_MODE` | `1` | set `0` to disable bootstrap/reset |

The database is swappable via the adapter in `src/core/db.ts`. Set
`AEGIS_DB_URL=postgres://user:pass@host:5432/db` and the ledger runs on
PostgreSQL with zero code changes (`?` placeholders are translated to `$n`).
Migration steps: create the three tables (SQL is emitted on startup via
`CREATE TABLE IF NOT EXISTS`), then set the env var.

## Demo hygiene for submission

- Reset demo data before recording (`Reset demo` in Command Center).
- Deploy on Vercel; set `AEGIS_DB_URL` to a Turso instance for persistence.
- Add GitHub collaborator `aadityajauhari01@gmail.com` **before** the deadline.
- **No commits after 2 Aug 2026, 6:00 PM IST.**
