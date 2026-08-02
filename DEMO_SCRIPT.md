# AEGIS — 7-Minute Demo Script (from scratch)

**Live app:** https://aegis-shivv23s-projects.vercel.app
**Repo:** https://github.com/shivv23/aegis

Run this **exactly once** before presenting so the ledger is clean and the
live feed is warm. Total timing ≈ 7:00. Spoken pace ≈ 150 words/min.

---

## Pre-flight checklist (do before the audience arrives)

1. Open the app in a fresh **Chrome/Edge profile** (no saved keys).
2. Click **Reset demo** in the Command Center (top-right), confirm the dialog.
   → reseeds `TradingBot-42`, clears test noise.
3. Refresh. The live feed should show the seeded history.
4. Keep the **Command Center** tab (SSE feed) and pre-open a second tab on
   `/audit` and a third on `/alerts` (you'll flip to them fast).
5. Close any laptop sleep / screen-saver.
6. Verify the master key was handed to the browser (Settings drawer shows a
   key; if not, click **Get key**).

If anything 500s during the demo, fall back to: *"that's the live
Postgres ledger being hammered — one refresh and we're back, which is also
the point of the kill switch."*

---

## 0:00 – 0:40 · HOOK & PROBLEM (landing, `/home`)

**Say:**
> "Every company is now giving AI agents money. The moment an agent holds a
> wallet, three things can go wrong: a prompt injection spends the whole
> balance, a buggy agent pays a blocked party, or an attacker steals the
> agent's token and drains it in seconds. No human reacts in time.
>
> AEGIS is the **kill switch that lives in the wallet itself**, not in the
> agent's head — so even a fully hostile agent is capped by construction."

**Do:** show the landing page; point at the "Enforcement lives in the wallet
layer" thesis line.

**Transition:** "Here's the architecture in one breath — then I'll show you
it working live."

## 0:40 – 1:20 · THE THESIS & ARCHITECTURE (one diagram, `README` mental model)

**Say:**
> "The agent is handed exactly one thing: a scoped key that can call one
> endpoint — `POST /api/rail/transfer`. That request hits an independent
> Policy Guard. The guard is pure code — limits, allowlist, velocity — that
> the agent cannot read, change, or bypass. Everything else — freezing,
> policy, revocation — belongs to the owner's key. And the agent doesn't just
> send a token: it **signs every request with an Ed25519 keypair**, so a
> stolen bearer token is useless without the private key."

**Do:** draw/narrate the diagram from README: agent → rail → guard → ledger,
owner above.

**Transition:** "Let's see it on the live production system."

## 1:20 – 2:00 · COMMAND CENTER + LIVE LEDGER (root `/`)

**Say:**
> "This is the live command center against a Postgres ledger on Vercel. The
> feed is a real-time SSE stream of every guard decision. We have a seeded
> agent wallet, TradingBot-42, with a $100 per-transaction cap, a $1,000
> daily limit, and three allowlisted vendors. Every row here is part of a
> SHA-256 hash chain — edit one row and the whole chain breaks."

**Do:** scroll wallet registry, show TradingBot-42's policy (limits,
allowlist). Point at the streaming feed updating.

**Transition:** "Now the part the agent actually experiences."

## 2:00 – 2:40 · AGENT IDENTITY + FIRST PAYMENT (Simulator → legit payment)

**Say:**
> "I'm going to act as the agent. I mint an agent keypair, then fire a
> legitimate payment through the SDK — signed, fresh, nonce-protected. Watch
> it go: request, guard pass, PENDING hold window, then SETTLED. If the owner
> were asleep, this settles without any human touch — that's the product."

**Do:** Simulator → mint agent key → fire "Legit payment" preset (or run
`scripts/agent-sim.ts` in a terminal to show the raw signed JSON).
Show the tx row flip PENDING → SETTLED in the feed/ledger.

**Transition:** "Now the interesting part — what happens when the agent tries
to cheat?"

## 2:40 – 3:30 · THE GUARD REFUSES (Simulator attack presets)

**Say:**
> "Three attacks, three blocks, all in the guard — not the agent.
> 1. Over the per-transaction cap → `LIMIT_EXCEEDED`.
> 2. A payee that isn't allowlisted → `NOT_ALLOWLISTED`.
> 3. A burst of 35 payments in a minute → `VELOCITY_LIMIT`.
>
> Every denial is an actor-stamped audit row with a reason code. There is no
> code path the agent can reach to weaken a rule — the guard is code, not
> data."

**Do:** fire the three presets (~15s each). Show the BLOCKED rows + reasons.

**Transition:** "And when the agent turns hostile — the owner has one button."

## 3:30 – 4:10 · KILL SWITCH + IN-FLIGHT REVOCATION

**Say:**
> "I'm about to engage the kill switch. The instant I do, every transfer from
> this wallet is refused — and the one that was mid-flight, holding in
> PENDING, gets **revoked in flight**, refunding the reservation so the daily
> cap doesn't leak. This is the bonus metric: the window is 5 seconds, long
> enough for a human to catch a runaway agent, short enough that the money
> still moves when it's honest. Release, and the wallet resumes."

**Do:** fire a transfer that holds → click **ENGAGE KILL SWITCH** → show
instant blocks + the pending tx flips to `REVOKED IN_FLIGHT_REVOKED` →
**Release**.

**Transition:** "That's reactive. AEGIS also predicts."

## 4:10 – 5:00 · RISK ENGINE → STEP-UP → APPROVAL OUTBOX

**Say:**
> "Even a fully policy-compliant transfer is scored 0–100 by the risk engine —
> amount vs cap, new payee, velocity burst, red-flag purpose, hour of day.
> Above 55 it's `STEP_UP_REQUIRED`: the money holds until a human approves.
> The approve decision travels as a one-tap deep link — email and Slack wire
> in with one env var each, and right now you can see the live **ops
> outbox** with the queued event and its approve/decline link. I approve —
> and it settles."

**Do:** fire a high-risk transfer → flip to `/alerts` → show the outbox
delivery log with the approve deep-link → click approve → show it settle.
Point at `/webhooks` tab: the delivery log with statuses.

**Transition:** "Now: how do you trust any of this?"

## 5:00 – 5:45 · TRUST: LEDGER VERIFY + AUDIT + RAILS + ON-CHAIN SEAL

**Say:**
> "Three proofs. First, `GET /api/ledger/verify` walks the entire hash chain —
> any edit, swap, or deletion fails. Second, the full audit trail is
> searchable and paginated; here's every action this session produced,
> actor-stamped. Third — the marquee — the active policy hash is sealed in a
> Solidity contract on Sepolia: the panel shows **verified on-chain**,
> `matches: true`, live limits read straight from the chain. And to be fully
> honest about it: settlement rails are clearly labeled — sandbox, USDC
> testnet, ACH-lite are all `simulated: true` with the reason shown, because
> no gateway key is configured. Nothing here pretends to move real money."

**Do:** flip to `/audit` (search "WALLET_CREATED" to show search), run
`/api/ledger/verify` (paste in address bar or show a terminal curl), show the
Guardian panel `verified`/`matches: true`, then `/api/rails` or the rails
view showing all three `simulated: true` with reasons.

**Transition:** "Finally — governance and scale."

## 5:45 – 6:30 · GOVERNANCE: MULTI-SIG, ORGS, ANALYTICS

**Say:**
> "Owner keys — the only credential that can change policy or hit the kill
> switch — are minted **2-of-3**: two distinct signers must approve before the
> key exists. Wallets are multi-tenant: orgs → teams → wallets, with budget
> groups capping the whole fleet against one monthly number, and policy that
> inherits down the org. The analytics console shows the guard funnel —
> requested → allowed → settled, the blocked-reason mix, and daily spend.
> Regulator export is one click: audit CSV, JSON, and a SAR-lite report."

**Do:** flip to `/multisig` (show 2 registered signers + the approval flow),
`/delegation` (org→team→wallet policy inheritance), `/analytics` (funnel +
blocked-reason chart), mention `/export`.

**Transition:** "And what you can't see in the browser…"

## 6:30 – 7:00 · CLOSE: SDKs + TEST MATRIX + THESIS

**Say:**
> "It's also a product for builders: a TypeScript SDK and a Python SDK that an
> agent stack actually runs, plus a CLI simulator that attacks the real API.
> And it's tested like a security product — 268 tests across 38 suites,
> including attack-resistance, replay, timelock, and property-based fuzzing of
> the guard, plus 10 Solidity tests for the on-chain mirror.
>
> The pitch: **AEGIS puts enforcement in the wallet, signs every agent action,
> gives a human a kill switch and a step-up approval — and can prove it all
> on a tamper-evident ledger mirrored on-chain.**"

**Do:** quick screenshot-drive of `/docs` and `/whitepaper` if time, or just
end on the thesis. Smile. Stop.

---

## Judge Q&A one-liners

- **"Where does the money actually move?"** — "Honestly labeled: sandbox and
  ACH-lite settle in-process; USDC testnet settles via Circle when the key is
  present. Every rail reports `simulated: true` with the reason — we don't
  fake real settlement."
- **"Can a stolen agent token drain the wallet?"** — "No. Transfers are
  Ed25519-signed with a freshness window and nonce; a bearer token alone can't
  sign a request. And even a signed request still hits the guard and limits."
- **"What if the owner key is stolen?"** — "Three backstops: policy edits are
  timelocked, the on-chain seal means the server can't silently rewrite
  limits, and sign-out revokes the key hash into a denylist the API rejects."
- **"How is the ledger tamper-proof?"** — "Every row is hash-chained; ask the
  API: `GET /api/ledger/verify`. And the active policy hash is sealed in
  `PolicyRegistry.sol` — a compromised server can't rewrite limits without
  breaking the chain and the chain doesn't lie."
- **"Why not just put limits in the agent?"** — "Because the agent can be
  injected, fine-tuned, or replaced. Enforcement must live where the money
  moves — the wallet layer — and be unreadable and unmodifiable by the agent."
- **"Tests?"** — "268 across 38 suites including attack-resistance and
  property-based fuzzing of the guard; 10 Hardhat tests for the Solidity
  mirror, live on Sepolia."
