"""AEGIS Python SDK tests (stdlib unittest — no pytest needed).

Verifies the canonical signed message exactly matches the TypeScript SDK /
server verifier, and that signatures produced here verify against the public
key (cross-language compatibility check).
"""

import base64
import json
import unittest
from unittest import mock

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

from aegis import Aegis, AegisError


def _keypair():
    priv = Ed25519PrivateKey.generate()
    priv_der = priv.private_bytes(
        serialization.Encoding.DER,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    pub_der = priv.public_key().public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return base64.urlsafe_b64encode(priv_der).rstrip(b"=").decode(), pub_der


class FakeResp:
    def __init__(self, status, payload):
        self.status = status
        self._payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return self._payload


class TestCanonicalMessage(unittest.TestCase):
    def test_message_format_matches_server(self):
        msg = Aegis.canonical_message(
            wallet_id="wallet-tradingbot-42",
            nonce="n-1",
            requested_at=1700000000000,
            to="compute:0xCAFE0001",
            amount=30,
            purpose="GPU burst",
        )
        self.assertEqual(
            msg,
            "aegis-agent-transfer|v1|wallet-tradingbot-42|n-1|1700000000000|compute:0xCAFE0001|30|GPU burst",
        )


class TestSigning(unittest.TestCase):
    def test_signature_verifies_with_public_key(self):
        priv_b64, pub_der = _keypair()
        agent = Aegis(wallet_id="w", private_key=priv_b64)
        msg = Aegis.canonical_message(
            wallet_id="w", nonce="n1", requested_at=1700000000000, to="t", amount=10, purpose="p"
        )
        sig = agent._sign(msg)
        pub = serialization.load_der_public_key(pub_der)
        assert isinstance(pub, Ed25519PublicKey)
        pub.verify(base64.urlsafe_b64decode(sig + "==="), msg.encode("utf-8"))

    def test_signature_is_base64url(self):
        priv_b64, _ = _keypair()
        agent = Aegis(wallet_id="w", private_key=priv_b64)
        sig = agent._sign("hello")
        self.assertNotIn("+", sig)
        self.assertNotIn("/", sig)
        self.assertFalse(sig.endswith("="))


class TestValidation(unittest.TestCase):
    def test_requires_credentials(self):
        with self.assertRaises(AegisError):
            Aegis()
        with self.assertRaises(AegisError):
            Aegis(private_key="x")

    def test_signed_transfer_sends_headers(self):
        priv_b64, _ = _keypair()
        agent = Aegis(base_url="http://example.com", wallet_id="wallet-tradingbot-42", private_key=priv_b64)

        def fake_open(req, timeout=30):
            headers = {k.lower(): v for k, v in req.headers.items()}
            body = json.loads(req.data or b"{}")
            self.assertEqual(headers["x-aegis-wallet"], "wallet-tradingbot-42")
            self.assertTrue(headers["x-aegis-signature"])
            self.assertTrue(int(headers["x-aegis-timestamp"]) > 0)
            self.assertTrue(body["nonce"])
            return FakeResp(201, b'{"status":"PENDING"}')

        with mock.patch("urllib.request.urlopen", side_effect=fake_open):
            r = agent.transfer(to="compute:0xCAFE0001", amount=30, purpose="GPU burst")
        self.assertEqual(r["_http_status"], 201)
        self.assertEqual(r["status"], "PENDING")

    def test_bearer_mode_uses_jwt(self):
        agent = Aegis(base_url="http://example.com", api_key="jwt-token")

        def fake_open(req, timeout=30):
            self.assertEqual(req.headers["Authorization"], "Bearer jwt-token")
            return FakeResp(200, b'{"ok":true}')

        with mock.patch("urllib.request.urlopen", side_effect=fake_open):
            r = agent.health()
        self.assertEqual(r["_http_status"], 200)


if __name__ == "__main__":
    unittest.main()

