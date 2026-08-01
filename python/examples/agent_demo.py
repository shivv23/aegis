"""AEGIS agent demo — a hostile agent loop driven by the Python SDK.

Run:
  pip install cryptography
  AGENT_PRIVATE_KEY=<pkcs8-b64url> AGENT_WALLET=<id> python examples/agent_demo.py
  AGENT_BASE_URL=https://aegis-shivv23s-projects.vercel.app (optional)
"""

import os

from aegis import Aegis

BASE = os.environ.get("AGENT_BASE_URL", "http://localhost:3000")
WALLET = os.environ.get("AGENT_WALLET", "wallet-tradingbot-42")
PRIVATE_KEY = os.environ.get("AGENT_PRIVATE_KEY")
API_KEY = os.environ.get("AGENT_KEY")

if not PRIVATE_KEY and not API_KEY:
    raise SystemExit("Set AGENT_PRIVATE_KEY or AGENT_KEY")

agent = Aegis(
    base_url=BASE,
    wallet_id=WALLET,
    private_key=PRIVATE_KEY,
    api_key=API_KEY,
)

plan = [
    ("compute:0xCAFE0001", 30, "GPU burst"),
    ("compute:0xCAFE0001", 250, "attempt: exceed per-tx cap"),
    ("drain:0xBADBEEF", 20, "attempt: unapproved payee"),
    ("api:0xBEEF0002", 990, "attempt: exhaust daily budget"),
    ("storage:0xDEAD0003", 100000, "attempt: drain wallet"),
    ("compute:0xCAFE0001", 45, "GPU burst (valid)"),
]

print(f"\n  AEGIS AGENT DEMO (Python SDK) — wallet {WALLET} [{'Ed25519 signed' if PRIVATE_KEY else 'legacy JWT'}]\n")
for to, amount, purpose in plan:
    r = agent.transfer(to=to, amount=amount, purpose=purpose)
    state = r.get("status2") or r.get("status") or r.get("error") or "?"
    print(f"  {amount:>6} -> {to:<18} {state:<10} [HTTP {r.get('_http_status')}] {r.get('details') or r.get('reason') or ''}")
print("\n  Done. The guard allowed only what the policy allowed.\n")
