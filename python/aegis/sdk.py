"""AEGIS Python SDK — the only thing an agent should ever hold.

Mirror of the TypeScript SDK (src/lib/sdk.ts). The agent holds an Ed25519
keypair and can call exactly one thing: `transfer()`. The guard decides.

```python
from aegis import Aegis

agent = Aegis(
    base_url="https://aegis-shivv23s-projects.vercel.app",
    wallet_id="wallet-tradingbot-42",
    private_key=os.environ["AGENT_PRIVATE_KEY"],  # PKCS8 DER base64url
)
result = agent.transfer(to="compute:0xCAFE0001", amount=30, purpose="GPU burst")
```

With a `private_key`, every transfer is Ed25519-signed — the agent *is* its
keypair. With only an `api_key`, requests use the legacy bearer JWT.
Only runtime dependency: `cryptography` (Ed25519). Pure-stdlib transport.
"""

from __future__ import annotations

import base64
import json
import time
import urllib.parse
import urllib.request
import uuid
from typing import Any, Dict, List, Optional, Union

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

CANONICAL_TAG = "aegis-agent-transfer"

Json = Union[Dict[str, Any], List[Any], str, int, float, bool, None]


class AegisError(Exception):
    """Raised for transport/configuration errors, not guard denials.

    Guard denials are returned as ``ok=False`` results so agents can react
    to a specific block reason."""


class Aegis:
    def __init__(
        self,
        base_url: str = "",
        api_key: Optional[str] = None,
        wallet_id: Optional[str] = None,
        private_key: Optional[str] = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.wallet_id = wallet_id
        self.private_key = private_key
        if not api_key and not private_key:
            raise AegisError("Aegis: provide an api_key or a private_key")
        if private_key and not wallet_id:
            raise AegisError("Aegis: wallet_id is required when using private_key")

    # -- signing ----------------------------------------------------------

    @classmethod
    def canonical_message(
        cls,
        *,
        wallet_id: str,
        nonce: str,
        requested_at: int,
        to: str,
        amount: Union[int, float],
        purpose: str = "agent-transfer",
    ) -> str:
        """Exact canonical message the rail verifies (matches the server)."""
        return "|".join(
            [
                CANONICAL_TAG,
                "v1",
                wallet_id,
                nonce,
                str(requested_at),
                to,
                str(amount),
                purpose,
            ]
        )

    def _sign(self, message: str) -> str:
        der = base64.urlsafe_b64decode(_pad(self.private_key or ""))
        key = serialization.load_der_private_key(der, password=None)
        assert isinstance(key, Ed25519PrivateKey)
        sig = key.sign(message.encode("utf-8"))
        return base64.urlsafe_b64encode(sig).rstrip(b"=").decode("ascii")

    # -- transport ----------------------------------------------------------

    def _request(
        self,
        path: str,
        method: str = "GET",
        body: Optional[Dict[str, Any]] = None,
        extra_headers: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        headers: Dict[str, str] = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        headers.update(extra_headers or {})
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(f"{self.base_url}{path}", data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read()
                result: Dict[str, Any] = json.loads(raw) if raw else {}
                result.setdefault("_http_status", resp.status)
                return result
        except urllib.error.HTTPError as e:
            raw = e.read()
            result = json.loads(raw) if raw else {}
            result.setdefault("_http_status", e.code)
            return result

    # -- agent rail (the one thing an agent can do) --------------------------

    def transfer(self, to: str, amount: Union[int, float], purpose: str = "agent-transfer") -> Dict[str, Any]:
        """Request a transfer. The guard decides; the agent cannot bypass it."""
        nonce = str(uuid.uuid4())
        requested_at = int(time.time() * 1000)
        body = {"to": to, "amount": amount, "purpose": purpose, "nonce": nonce}
        headers: Dict[str, str] = {}
        if self.private_key:
            message = self.canonical_message(
                wallet_id=self.wallet_id or "",
                nonce=nonce,
                requested_at=requested_at,
                to=to,
                amount=amount,
                purpose=purpose,
            )
            headers["x-aegis-wallet"] = self.wallet_id or ""
            headers["x-aegis-timestamp"] = str(requested_at)
            headers["x-aegis-signature"] = self._sign(message)
        return self._request("/api/rail/transfer", method="POST", body=body, extra_headers=headers)

    def health(self) -> Dict[str, Any]:
        return self._request("/api/rail/health")

    # -- keys ----------------------------------------------------------------

    def mint_agent_key(self, wallet_id: str, label: str = "agent") -> Dict[str, Any]:
        return self._request("/api/keys/mint", method="POST", body={"walletId": wallet_id, "label": label})

    def scoped_keys(self, wallet_id: str) -> Dict[str, Any]:
        return self._request(f"/api/keys?walletId={urllib.parse.quote(wallet_id, safe='')}")

    # -- owner control plane ---------------------------------------------------

    def create_wallet(
        self,
        *,
        name: str,
        owner_did: str,
        balance: float,
        policy: Dict[str, Any],
        org_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {
            "name": name,
            "ownerDid": owner_did,
            "balance": balance,
            "policy": policy,
        }
        if org_id:
            body["orgId"] = org_id
        return self._request("/api/wallet", method="POST", body=body)

    def list_wallets(self) -> Dict[str, Any]:
        return self._request("/api/wallet")

    def get_wallet(self, wallet_id: str) -> Dict[str, Any]:
        return self._request(f"/api/wallet/{urllib.parse.quote(wallet_id, safe='')}")

    def patch_policy(self, wallet_id: str, policy: Dict[str, Any]) -> Dict[str, Any]:
        return self._request(f"/api/wallet/{urllib.parse.quote(wallet_id, safe='')}", method="PATCH", body={"policy": policy})

    def freeze(self, wallet_id: str) -> Dict[str, Any]:
        return self._request(f"/api/wallet/{urllib.parse.quote(wallet_id, safe='')}/freeze", method="POST")

    def unfreeze(self, wallet_id: str) -> Dict[str, Any]:
        return self._request(f"/api/wallet/{urllib.parse.quote(wallet_id, safe='')}/unfreeze", method="POST")

    def list_transactions(self) -> Dict[str, Any]:
        return self._request("/api/transactions")

    def revoke(self, tx_id: str) -> Dict[str, Any]:
        return self._request(f"/api/transactions/{urllib.parse.quote(tx_id, safe='')}/revoke", method="POST")

    def step_up(self, tx_id: str, decision: str) -> Dict[str, Any]:
        return self._request(f"/api/transactions/{urllib.parse.quote(tx_id, safe='')}/stepup", method="POST", body={"decision": decision})

    # -- systems ----------------------------------------------------------------

    def verify_ledger(self) -> Dict[str, Any]:
        return self._request("/api/ledger/verify")

    def audit(self) -> Dict[str, Any]:
        return self._request("/api/audit")

    def outbox(self) -> Dict[str, Any]:
        return self._request("/api/outbox")

    def rails(self) -> Dict[str, Any]:
        return self._request("/api/rails")

    def guardian(self) -> Dict[str, Any]:
        return self._request("/api/guardian")

    def breaker(self) -> Dict[str, Any]:
        return self._request("/api/breaker")

    def simulate(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self._request("/api/simulate", method="POST", body=payload)

    # -- multi-sig -------------------------------------------------------------

    def list_signers(self) -> Dict[str, Any]:
        return self._request("/api/signers")

    def register_signer(self, name: str, role: str) -> Dict[str, Any]:
        return self._request("/api/signers", method="POST", body={"name": name, "role": role})

    def remove_signer(self, signer_id: str) -> Dict[str, Any]:
        return self._request(f"/api/signers/{urllib.parse.quote(signer_id, safe='')}", method="DELETE")

    def list_approvals(self) -> Dict[str, Any]:
        return self._request("/api/approvals")

    def propose_approval(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self._request("/api/approvals", method="POST", body=payload)

    def approve_approval(self, approval_id: str) -> Dict[str, Any]:
        return self._request(f"/api/approvals/{urllib.parse.quote(approval_id, safe='')}/approve", method="POST")

    def reject_approval(self, approval_id: str) -> Dict[str, Any]:
        return self._request(f"/api/approvals/{urllib.parse.quote(approval_id, safe='')}/reject", method="POST")

    # -- orgs -------------------------------------------------------------------

    def list_orgs(self) -> Dict[str, Any]:
        return self._request("/api/orgs")

    def create_org(self, name: str) -> Dict[str, Any]:
        return self._request("/api/orgs", method="POST", body={"name": name})

    def get_org(self, org_id: str) -> Dict[str, Any]:
        return self._request(f"/api/orgs/{urllib.parse.quote(org_id, safe='')}")


def _pad(s: str) -> str:
    return s + "=" * (-len(s) % 4)


__all__ = ["Aegis", "AegisError"]
