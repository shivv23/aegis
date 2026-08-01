#!/usr/bin/env bash
# AEGIS — fetch the demo master owner key from GET /api/bootstrap.
#   Usage: AEGIS_BASE_URL=http://localhost:3000 ./0-bootstrap.sh
set -euo pipefail
BASE="${AEGIS_BASE_URL:-http://localhost:3000}"

echo "== GET $BASE/api/bootstrap"
RESP="$(curl -sf "$BASE/api/bootstrap")"
echo "$RESP"

KEY="$(printf '%s' "$RESP" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["ownerKey"])' 2>/dev/null \
  || printf '%s' "$RESP" | jq -r .ownerKey)"

printf '%s' "$KEY" > .aegis-owner-key
echo
echo "master owner key written to ./.aegis-owner-key"
echo "  export AEGIS_OWNER_KEY=\"\$(cat .aegis-owner-key)\""
