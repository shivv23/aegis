#!/usr/bin/env bash
# AEGIS — read-only GETs with the owner key: rail health, wallet list,
# counterparties. All owner-scoped endpoints; ledger verify is in the Go sample.
#   Usage: AEGIS_BASE_URL=http://localhost:3000 AEGIS_OWNER_KEY=<key> ./1-status.sh
set -euo pipefail
BASE="${AEGIS_BASE_URL:-http://localhost:3000}"
KEY="${AEGIS_OWNER_KEY:-$(cat .aegis-owner-key 2>/dev/null || true)}"
[ -n "$KEY" ] || { echo "set AEGIS_OWNER_KEY or run ./0-bootstrap.sh first"; exit 1; }

echo "== GET $BASE/api/rail/health"
curl -sf -H "Authorization: Bearer $KEY" "$BASE/api/rail/health"; echo

echo "== GET $BASE/api/wallet"
curl -sf -H "Authorization: Bearer $KEY" "$BASE/api/wallet"; echo

echo "== GET $BASE/api/counterparties"
curl -sf -H "Authorization: Bearer $KEY" "$BASE/api/counterparties"; echo
