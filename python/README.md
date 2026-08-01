# AEGIS Python SDK

The Python mirror of the TypeScript SDK (`src/lib/sdk.ts`) — the only thing
an autonomous agent should ever hold. The agent gets an Ed25519 keypair and
one action: `transfer()`. The guard decides everything else.

## Install

```bash
cd python
pip install -e .          # requires cryptography
```

## Usage

```python
import os
from aegis import Aegis

agent = Aegis(
    base_url="https://aegis-shivv23s-projects.vercel.app",
    wallet_id="wallet-tradingbot-42",
    private_key=os.environ["AGENT_PRIVATE_KEY"],  # PKCS8 DER base64url
)

r = agent.transfer(to="compute:0xCAFE0001", amount=30, purpose="GPU burst")
# { "status": "PENDING", "_http_status": 201, ... }   <- guard decides
```

- With `private_key`, every transfer is **Ed25519-signed** (canonical message
  byte-for-byte identical to the server verifier) — the agent *is* its keypair.
- With only `api_key`, requests use the legacy bearer JWT.
- Guard denials (`LIMIT_EXCEEDED`, `NOT_ALLOWLISTED`, `WALLET_FROZEN`, ...)
  are returned as results, not exceptions, so agents can react per reason.

Full surface: `mint_agent_key`, `scoped_keys`, `create_wallet`, `freeze`,
`unfreeze`, `patch_policy`, `revoke`, `step_up`, `verify_ledger`, `audit`,
`outbox`, `rails`, `guardian`, `breaker`, `simulate`, multi-sig signer/
approval flows, and `list_orgs`/`create_org`/`get_org` (multi-tenant).

## Demo

```bash
cd python
pip install cryptography
AGENT_PRIVATE_KEY=<pkcs8-b64url> AGENT_WALLET=wallet-tradingbot-42 python examples/agent_demo.py
```

## Tests

```bash
cd python
python -m unittest discover -s tests -v   # 6 tests, no pytest needed
```

Test coverage: canonical-message parity with the server, signature
verification, header/body correctness for signed and bearer modes.
