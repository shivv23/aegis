#!/usr/bin/env python3
"""AEGIS — runnable Python sample agent (standard library only).

Flow:
  1. Bootstraps with AEGIS_OWNER_KEY (master key from GET /api/bootstrap).
  2. Provisions a wallet and grabs the legacy agent JWT it returns.
  3. Lists counterparties (owner control plane).
  4. POSTs a transfer via /api/rail/transfer using the agent JWT (bearer).

Ed25519 signed transfers (preferred — no bearer secrets on the wire) sign the
canonical message with the private key returned by POST /api/keys/mint:

  canonical = "aegis-agent-transfer|v1|{walletId}|{nonce}|{requestedAt}|{to}|{amount}|{purpose}"

With the optional `cryptography` package:

  import base64
  from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
  der = base64.urlsafe_b64decode(pkcs8_b64url + "==")
  key = Ed25519PrivateKey.from_der(der)
  sig = base64.urlsafe_b64encode(key.sign(canonical.encode())).decode().rstrip("=")

Then POST with headers: x-aegis-wallet, x-aegis-timestamp, x-aegis-signature.

Run:  AEGIS_BASE_URL=http://localhost:3000 AEGIS_OWNER_KEY=<key> python3 agent.py
"""

import json
import os
import urllib.request
import uuid

BASE = os.environ.get("AEGIS_BASE_URL", "http://localhost:3000").rstrip("/")
OWNER_KEY = os.environ.get("AEGIS_OWNER_KEY")


def call(path, token, body=None):
    method = "POST" if body is not None else "GET"
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        method=method,
    )
    with urllib.request.urlopen(req) as res:
        return res.status, json.loads(res.read())


def main():
    if not OWNER_KEY:
        print("Missing AEGIS_OWNER_KEY. Fetch it from GET /api/bootstrap.")
        raise SystemExit(1)

    status, provisioned = call("/api/wallet", OWNER_KEY, {
        "name": "python-agent-wallet",
        "ownerDid": "did:org:acme",
        "balance": 500,
        "policy": {
            "maxPerTx": 100,
            "dailyLimit": 1000,
            "monthlyLimit": 5000,
            "velocityLimitPerMin": 30,
            "allowlist": ["compute:0xCAFE0001", "api:0xBEEF0002"],
        },
    })
    wallet = provisioned["wallet"]
    agent_jwt = provisioned["agentKey"]
    print(f"\n  wallet {wallet['id']} provisioned [HTTP {status}] (agent JWT issued)")

    status, counterparties = call("/api/counterparties", OWNER_KEY)
    print(f"  counterparties: {len(counterparties['counterparties'])} on file [HTTP {status}]")

    status, result = call("/api/rail/transfer", agent_jwt, {
        "to": "compute:0xCAFE0001",
        "amount": 30,
        "purpose": "GPU burst",
        "nonce": str(uuid.uuid4()),
    })
    tx = result.get("transaction", {})
    print(f"  transfer -> {result.get('status')} [HTTP {status}] tx={tx.get('id')}\n")


main()
