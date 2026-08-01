# AEGIS — curl scripts

Copy-paste shell scripts against the public API.

| script | what it does |
| --- | --- |
| `0-bootstrap.sh` | `GET /api/bootstrap` → writes the master owner key to `.aegis-owner-key` |
| `1-status.sh` | read-only GETs with the owner key: rail health, wallet list, counterparties |
| `2-transfer.sh` | documents the signed-transfer envelope and shows how to run it via the CLI |

## Run

```sh
AEGIS_BASE_URL=http://localhost:3000 ./0-bootstrap.sh
export AEGIS_OWNER_KEY="$(cat .aegis-owner-key)"
./1-status.sh
```

Transfers are signed (Ed25519) by the SDK — plain curl cannot produce the
signature. Use `2-transfer.sh` to see the envelope, then send one for real:

```sh
npx tsx scripts/aegis.ts transfer \
  --wallet wallet-tradingbot-42 --to compute:0xCAFE0001 \
  --amount 30 --purpose "GPU burst"
```
