# AEGIS — Node/TS sample agent

A runnable sample that exercises the exact surface a real agent integrates
with: the AEGIS SDK (`src/lib/sdk.ts`). The agent holds ONLY its Ed25519
private key and calls one thing — `transfer()`. The guard decides.

## What it does

1. Bootstraps with `AEGIS_BASE_URL` + `AEGIS_OWNER_KEY` (master key from
   `GET /api/bootstrap`).
2. Provisions a wallet (owner control plane) with a strict policy.
3. Mints an Ed25519 agent keypair via `POST /api/keys/mint`.
4. Signs two transfers with the agent private key: one inside policy
   (`PENDING`) and one that blows past the per-tx cap (`BLOCKED`).
5. Prints both results so you can see the guard — not the agent — decide.

## Run

```sh
AEGIS_BASE_URL=http://localhost:3000 \
AEGIS_OWNER_KEY=<master-key> \
npx tsx examples/node/agent.ts
```

The master key is returned by `GET /api/bootstrap`, or printed by:

```sh
npx tsx scripts/aegis.ts bootstrap
```
