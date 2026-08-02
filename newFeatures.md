# AEGIS — New Features Worth Building (hardcore judge / end-user lens)

Audit date: 2026-08-02 · Live: **https://aegis-shivv23s-projects.vercel.app**

Lens: every idea below is what a *hostile evaluator will actually probe* or a
*real end-user (finance ops, treasury, compliance) will actually ask for* —
not feature-creep. Each one maps to a specific judge question that the current
product can only partially answer. Everything is rated for **demo value** (how
visible it is in a live walkthrough) and **effort** (S/M/L for one engineer).

What already exists (so these don't repeat it): per-tx/daily/monthly/velocity
limits, allowlist, kill switch, in-flight revoke, Ed25519 agent identity,
nonce/replay protection, timelocked policy versions, hash-chained ledger,
risk engine, step-up deep-links, circuit breaker, simulated rails, 2-of-3
multi-sig owner keys, multi-tenant orgs + budget groups, spending windows/geo,
counterparty registry, escrows, usage metering, multi-currency, regulator
export, key lifecycle (rotate/revoke/expire), LLM classifier, webhook push +
in-app outbox, what-if simulator, on-chain Guardian + sealed policy registry,
analytics, billing/invoices, delegation (org→team→wallet policy inheritance).

---

## Tier 1 — Compliance & trust (the questions every fintech judge asks first)

These close the biggest remaining credibility gaps: AML, least-privilege,
and provable integrity.

### 1. Sanctions / watchlist screening (OFAC-lite)
- **What**: at counterparty registration *and* on every transfer, screen the
  payee name/handle/IBAN-style ID against a bundled SDN-lite watchlist.
  A match → `BLOCKED SANCTIONED` before any other guard check runs; flags are
  audited with the screener version so the decision is reproducible.
- **Why a judge cares**: the #1 question for a money-movement demo is
  *"where is your AML?"* Right now a judge can register `"Hamas Fronting
  Co."` and AEGIS will happily allowlist and pay it. That is the single most
  damaging thing a hostile judge can type into the current product.
- **Demo value**: 10/10 — type a known bad name, watch it refuse in under a
  second, show the audit line.
- **Effort**: M. A static JSON watchlist + name-normalization matcher in the
  guard (`src/core/guard.ts`), a registry flag, and a reason code. No API keys.
- **Fits**: `counterparties` registry + `guard` + `audit` already exist.

### 2. Read-only Auditor role + RBAC (separation of duties)
- **What**: mint keys with a `scope: auditor` that can read ledger, audit,
  export, guardian — but can touch nothing. UI hides all mutating controls
  for an auditor session. Optionally a `scope: operator` that can freeze/
  revoke but not edit policy.
- **Why a judge cares**: the product claims least-privilege but the only two
  roles are "agent" (rail only) and "owner" (everything). A security evaluator
  will ask *"who reviews the owner?"* The answer today is "nobody."
- **Demo value**: 8/10 — sign in as auditor, show read-only, try a mutation,
  get 403 with an audit entry.
- **Effort**: M. Key scope plumbing exists (`src/core/api.ts` + `keys.ts`);
  add scope checks to mutating routes + a UI role banner.
- **Fits**: auth scopes + `/api/audit` + `/api/keys`.

### 3. Signed, verifiable regulator export (offline proof)
- **What**: `GET /api/export?kind=audit.json` returns the pack **plus** a
  `.proof` — the SHA-256 of the pack, the root hash of the ledger, and a
  signature the reviewer can check with the published public key. Anyone can
  verify the CSV a regulator received actually came from the tamper-evident
  ledger, offline, without trusting the server.
- **Why a judge cares**: export exists, but a judge can't tell if the file is
  genuine or hand-edited. A signed proof turns "trust my API" into
  "verify with a shell one-liner."
- **Demo value**: 7/10 — download pack, show `sha256sum` + verify script.
- **Effort**: S. The hash chain + keys already exist; add a signature header.
- **Fits**: `src/core/export.ts` + `src/core/ledger.ts`.

### 4. Structuring / smurfing detection
- **What**: a stats pass over settled+rejected transfers that flags clusters
  of many small same-beneficiary payments inside a day that jointly breach a
  cap — an alert (not a hard block), escalated via the outbox.
- **Why a judge cares**: splitting-to-avoid-caps is the obvious bypass of the
  per-tx cap and the current *reservation* logic already stops the daily cap
  split; making that protection *visible* as a named detection wins credibility.
- **Demo value**: 6/10 — fire 5×$25 to one payee, watch the alert.
- **Effort**: S-M. A group-by scan in the analytics/risk path.
- **Fits**: `src/core/analytics` + outbox.

---

## Tier 2 — Ownership & approval UX (answers the "shared bearer secret" critique)

### 5. Passkey / WebAuthn step-up approval
- **What**: the owner approves a `STEP_UP_REQUIRED` transfer with a hardware
  security key / biometric (FIDO2/WebAuthn) instead of pasting a bearer
  secret. The deep-link flow stays; the decision is additionally signed by the
  authenticator. Physical presence, not a copied token.
- **Why a judge cares**: P2-2's core criticism is "a leaked bearer key works."
  A hardware-key step-up is the canonical answer and is extremely
  demo-visible (plug a YubiKey, tap, transfer settles).
- **Demo value**: 9/10 — it's the money shot for a security-minded judge.
- **Effort**: L. `simplewebauthn` server + challenge route + bind to the
  decision JWT. Keep bearer fallback behind env flag for the demo seed.
- **Fits**: `/approve/[id]` + `stepup` routes.

### 6. Policy-change approval workflow (human-in-the-loop on limits)
- **What**: editing a limit doesn't just wait out the timelock — it opens an
  approval (same 2-of-3 machinery) and the change commits only when signers
  approve *and* the timelock elapses. Steal the owner key and you can
  *propose*, never *impose*.
- **Why a judge cares**: timelock is passive (just waits). An approval on top
  shows a governance model, and pairs with the multi-sig story already built.
- **Demo value**: 7/10 — propose a limit change, approve with 2 signers, watch
  it land in the version history.
- **Effort**: M. Reuse `approvals` table; add a `pending_policy` reference.
- **Fits**: `src/core/store.ts` policy versions + `approvals`.

### 7. On-call escalation for unacknowledged step-up
- **What**: if a `STEP_UP_REQUIRED` transfer isn't decided within its TTL,
  escalate to the next on-call (Slack mention), and after a grace window
  auto-hold (never silently approve). Shows ops maturity.
- **Why a judge cares**: "what happens if the owner is asleep?" is a natural
  ops question; today the tx just expires.
- **Demo value**: 5/10 (needs a Slack webhook to be dramatic; otherwise show
  the escalation state machine).
- **Effort**: M. Outbox already carries the events; add a scheduler pass.
- **Fits**: outbox + notify + stepup TTL.

### 8. Owner-key action scoping + per-key TTL
- **What**: owner keys minted for a single action family (`policy`,
  `freeze`, `audit`) and a configurable short TTL at mint time, instead of
  one all-powerful 365-day owner token.
- **Why a judge cares**: least-privilege goes deeper than agent-vs-owner.
- **Demo value**: 5/10.
- **Effort**: S. Claims already support `canDo`; add mint-time restriction.

---

## Tier 3 — End-user / merchant workflows (a real finance ops user will want these)

### 9. Batch & recurring transfers
- **What**: `POST /api/rail/batch` (CSV: payee, amount, purpose, idempotency
  key per row) that runs every row through the same guard, returns a per-row
  result + batch summary, and one outbox summary. Plus recurring schedules
  (cron-like) that are **re-evaluated by the guard at execution time**, so a
  policy tightened yesterday blocks today's scheduled run.
- **Why a judge cares**: payroll is the canonical agent-treasury workload and
  "scheduled" is what every payments product eventually needs.
- **Demo value**: 8/10 — upload a 10-row payroll, see a color-coded result
  table (paid / blocked / step-up).
- **Effort**: M. The guard is pure and reusable; batch is mostly glue.
- **Fits**: rail + state machine + outbox.

### 10. Funding & withdrawal lifecycle (money in, then money out)
- **What**: a simulated on-ramp — "Wire/ACH deposit" event that credits a
  wallet, and a withdrawal that debits and moves funds to a (simulated) bank
  account. Balances then visibly *move*, and the funding events land in the
  same hash-chained ledger.
- **Why a judge cares**: right now wallets start with a balance that never
  changes on the credit side; an end-user will ask "how does money get in?"
- **Demo value**: 8/10 — deposit → balance ticks up → transfer → balance ticks
  down. Very intuitive.
- **Effort**: M. New tx kinds `DEPOSIT`/`WITHDRAWAL` in the state machine +
  a funding rail.
- **Fits**: state machine + rails + ledger.

### 11. Budget threshold alerts + acknowledgement
- **What**: at 80% and 100% of a daily/monthly/budget-group limit, emit a
  warning event; ops can acknowledge it (who + why), and the ack is audited.
  Proactive, not just reactive blocking.
- **Why a judge cares**: alerting at the moment of a *block* is reactive;
  thresholds show an ops product, not a toy.
- **Demo value**: 6/10 — set a tight budget, watch the 80% warning appear.
- **Effort**: S. Check ratio on every guard pass; reuse outbox + audit.
- **Fits**: guard + outbox.

### 12. Settlement explorer (make simulated rails look like a real trail)
- **What**: a page that renders each settled transfer's reference as an
  explorer card — `local://…`, an Etherscan-linked tx hash for
  `usdc-testnet`/guardian ops, `ach://…` for the bank rail — with a
  "verify on chain" link where one exists.
- **Why a judge cares**: P0-2's fix made rails honest, but the *visual*
  answer to "where does money move?" is still weak. A settlement explorer
  turns each ref into something a finance person can read.
- **Demo value**: 7/10 — click a settled tx, see its settlement card.
- **Effort**: S-M. Pure UI over existing refs + optional explorer URLs.
- **Fits**: transactions page + rails refs.

### 13. Transaction timeline drawer + processing-time metrics
- **What**: per-tx timeline (requested → guard pass → step-up → settled) with
  actor + latency at each hop; p50/p95 request-to-settlement on analytics.
- **Why a judge cares**: makes the system feel instrumented and debuggable.
- **Demo value**: 6/10.
- **Effort**: S. Timestamps already exist; render + percentile calc.
- **Fits**: transactions + analytics.

---

## Tier 4 — Ops & scale polish (quick wins that read as "enterprise")

### 14. Security events feed (SIEM-lite)
- **What**: a dedicated `/api/security` feed of failed auth, revoked keys,
  policy edits, freeze toggles, signer votes — separate from the tx feed, so
  a judge sees the *system watching itself*.
- **Why a judge cares**: "what did someone try to do to my system?" is a
  question no other panel can answer.
- **Demo value**: 7/10 — try a wrong key, watch it appear as a security event.
- **Effort**: S. `request_audit` table already records failures; just surface.
- **Fits**: `request_audit` + a new route + `/audit` page tab.

### 15. Chaos / load generator ("fire 100 transfers")
- **What**: a one-click page that fires N concurrent signed transfers and
  charts outcome + latency, letting a judge *try to break* velocity and the
  breaker live.
- **Why a judge cares**: self-demonstrating robustness; velocity/breaker are
  hard to hit by hand.
- **Demo value**: 8/10 — burst of 60 → velocity blocks + breaker trips on
  anomalies, then auto-heals.
- **Effort**: M. Reuse the SDK; add a page + chart.
- **Fits**: simulator + breaker + analytics.

### 16. Global (org-wide) kill switch
- **What**: freeze every wallet in an org (or the whole fleet) in one action,
  with a per-org freeze state that overrides wallet ACTIVE.
- **Why a judge cares**: "kill one wallet" is good; "stop the entire agent
  fleet in one click" is the *kill switch* headline taken to scale.
- **Demo value**: 8/10 — flip one switch, every wallet's transfers die.
- **Effort**: S. orgs + wallet state already exist; add `org.frozen`.
- **Fits**: orgs + guard.

### 17. Environments (sandbox / live) for the console
- **What**: a visible toggle labeling the console as SANDBOX vs LIVE with
  distinct chrome, so nobody mistakes simulated rails for production.
- **Why a judge cares**: reinforces the honesty story (P0-2) and is a real
  enterprise product need.
- **Demo value**: 5/10.
- **Effort**: S. Env banner + settings flag.
- **Fits**: layout shell + rails.

### 18. Batch UI actions + saved searches
- **What**: multi-select freeze/revoke across wallets; saved filters on
  transactions/audit.
- **Demo value**: 4/10. Effort: S.
- **Fits**: command center + audit pages.

---

## Highest leverage for the time you have left

| # | Feature | Demo value | Effort | Verdict |
|---|---|---|---|---|
| 1 | Sanctions screening (OFAC-lite) | 10/10 | M | **Build first** — closes the only remaining "type a bad name" hole |
| 14 | Security events feed | 7/10 | S | Build second — cheap, huge credibility |
| 2 | Auditor role / RBAC | 8/10 | M | Strong; do after sanctions |
| 12 | Settlement explorer | 7/10 | S | Cheap visual answer to P0-2 |
| 5 | Passkey step-up | 9/10 | L | Only if you have time — the flashiest |
| 9 | Batch/recurring transfers | 8/10 | M | Great end-user story |

**Skip for the demo** (effort > payoff in 48h): 7 (needs Slack), 18, 17, 8.

**Honesty rule**: anything new that touches money movement must carry the same
`simulated` labeling discipline we applied to rails — a judge verifying the
demo with a hostile eye should never find a fake presented as real.
