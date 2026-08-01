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

## Stack

- **Next.js 16 (App Router)** + **TypeScript (strict)** — API routes are the payment rail
- **Tailwind CSS 4** + lucide-react — terminal-styled dashboard
- **libSQL (`@libsql/client`)** — persistent, append-only ledger (works on Vercel via Turso)
- **Zod** — runtime validation at every API boundary
- **jose (JWT/HMAC)** — scoped agent vs owner keys
- **SSE** — live transaction stream to the dashboard
- **Vitest** — 25 tests incl. attack-resistance suite

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
| `GET`/`PATCH` | `/api/wallet/:id` | View / edit policy |
| `POST` | `/api/wallet/:id/freeze` | **Engage kill switch** |
| `POST` | `/api/wallet/:id/unfreeze` | Release kill switch |
| `POST` | `/api/transactions/:id/revoke` | Revoke an in-flight transaction |
| `GET` | `/api/transactions` | Ledger view |
| `GET` | `/api/transactions/stream` | SSE live feed |
| `GET` | `/api/audit` | Audit trail |
| `GET` | `/api/keys?walletId=` | Mint scoped keys |
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
2. **Guard is code, not data.** Policy *values* change at runtime; enforcement
   *logic* cannot. There is no code path an agent can reach to weaken a rule.
3. **Reservation on approval.** In-flight transfers count against limits
   immediately, so splitting a payment under the per-tx cap can't beat the
   daily cap (covered by tests).
4. **Replay protection.** Every transfer needs a fresh nonce.
5. **Append-only ledger.** Nothing is edited, only transitioned; the state
   machine rejects illegal transitions (`SETTLED → REVOKED` throws).

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
    stateMachine.ts#   tx status transitions
    keys.ts        #   scoped JWT signing/verification
    store.ts       #   libSQL ledger + SSE event bus
    seed.ts        #   demo data
    guard.test.ts  #   25 tests incl. attack resistance
  app/api/         # payment rail + owner control plane (Route Handlers)
  app/*.tsx        # Command Center, Wallet Registry, Wallet detail,
                   # Transactions, Audit, Agent Simulator
  components/      # dashboard + simulator console
  hooks/use-stream.ts  # SSE client
scripts/agent-sim.ts  # standalone CLI agent that attacks the real rail
```

## Environment

| Variable | Default | Notes |
|---|---|---|
| `AEGIS_SECRET` | dev secret | HMAC secret for scoped keys — **set in prod** |
| `AEGIS_DB_URL` | `file:./data/aegis.db` | set to a Turso `libsql://` URL to persist on Vercel |
| `AEGIS_HOLD_MS` | `5000` | in-flight revocation window |
| `AEGIS_DEMO_MODE` | `1` | set `0` to disable bootstrap/reset |

## Demo hygiene for submission

- Reset demo data before recording (`Reset demo` in Command Center).
- Deploy on Vercel; set `AEGIS_DB_URL` to a Turso instance for persistence.
- Add GitHub collaborator `aadityajauhari01@gmail.com` **before** the deadline.
- **No commits after 2 Aug 2026, 6:00 PM IST.**
