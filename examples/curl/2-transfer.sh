#!/usr/bin/env bash
# AEGIS — a signed transfer: what it looks like as raw HTTP, and how to run it
# for real.
#
# NOTE: plain curl cannot produce the Ed25519 signature the rail verifies, so
# signing happens inside the SDK (examples/node/agent.ts) or the CLI:
#
#   AEGIS_OWNER_KEY=$(cat .aegis-owner-key) npx tsx scripts/aegis.ts transfer \
#     --wallet <id> --to compute:0xCAFE0001 --amount 30 --purpose "GPU burst"
#
# The envelope below is what the SDK signs and POSTs (canonical message over
# the header fields + body): x-aegis-wallet, x-aegis-timestamp,
# x-aegis-signature. With a legacy agent JWT (agentKey from POST /api/wallet)
# you may instead send Authorization: Bearer <agent-jwt> with the same body.
set -euo pipefail
BASE="${AEGIS_BASE_URL:-http://localhost:3000}"
NONCE="${NONCE:-$( (uuidgen 2>/dev/null || echo "$(date +%s%N)-$$") )}"

echo "== POST $BASE/api/rail/transfer (documented envelope; signing via SDK)"
cat <<EOF
curl -sf -X POST "$BASE/api/rail/transfer" \\
  -H 'Content-Type: application/json' \\
  -H 'x-aegis-wallet: <wallet-id>' \\
  -H 'x-aegis-timestamp: \$(date +%s000)' \\
  -H 'x-aegis-signature: <ed25519 of canonical message>' \\
  -d '{"to":"compute:0xCAFE0001","amount":30,"purpose":"GPU burst","nonce":"$NONCE"}'
EOF
echo
echo "Canonical message to sign:"
echo "  aegis-agent-transfer|v1|<wallet-id>|$NONCE|\$(date +%s000)|compute:0xCAFE0001|30|GPU burst"
echo
echo "Run it for real with the CLI:"
echo "  AEGIS_OWNER_KEY=\$(cat .aegis-owner-key) npx tsx scripts/aegis.ts transfer \\"
echo "    --wallet <wallet-id> --to compute:0xCAFE0001 --amount 30 --purpose 'GPU burst'"
