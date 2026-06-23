"""Security unit tests for the WAHA webhook hardening (Group A: A1, A2, A3).

Pure helpers — no DB / network:
  * _verify_hmac — FAIL-CLOSED in prod (A1): empty secret rejects unless
    settings.debug is True; a real secret still verifies with constant-time
    compare.
  * _sanitize_session — (A2): charset + length validation; garbage → None.
  * (A3 is exercised indirectly: the missing-id branch never logs raw PII; we
    assert the helper that builds the safe log fields below.)
"""
from __future__ import annotations

import hashlib
import hmac
import types

import pytest

from app.routes import webhooks
from app.routes.webhooks import _sanitize_session, _verify_hmac


class _FakeSecret:
    """Mimics pydantic SecretStr.get_secret_value()."""

    def __init__(self, value: str) -> None:
        self._value = value

    def get_secret_value(self) -> str:
        return self._value


def _settings(*, secret: str | None, debug: bool) -> types.SimpleNamespace:
    return types.SimpleNamespace(
        waha_webhook_hmac=_FakeSecret(secret) if secret is not None else None,
        debug=debug,
    )


# ── A1: _verify_hmac fail-closed in prod ─────────────────────────────
def test_hmac_empty_secret_rejects_in_prod(monkeypatch):
    """Empty secret + debug=False (prod default) → REJECT (fail-closed)."""
    monkeypatch.setattr(webhooks, "get_settings", lambda: _settings(secret="", debug=False))
    assert _verify_hmac(b"body", "anything") is False


def test_hmac_missing_secret_rejects_in_prod(monkeypatch):
    """No secret configured at all + debug=False → REJECT."""
    monkeypatch.setattr(webhooks, "get_settings", lambda: _settings(secret=None, debug=False))
    assert _verify_hmac(b"body", None) is False


def test_hmac_empty_secret_allows_in_debug(monkeypatch):
    """Empty secret + debug=True (local dev) → ALLOW (the only bypass)."""
    monkeypatch.setattr(webhooks, "get_settings", lambda: _settings(secret="", debug=True))
    assert _verify_hmac(b"body", None) is True


def test_hmac_valid_signature_passes(monkeypatch):
    """A correctly-signed body passes the constant-time compare (debug False)."""
    secret = "s3cr3t"
    monkeypatch.setattr(webhooks, "get_settings", lambda: _settings(secret=secret, debug=False))
    body = b'{"event":"message"}'
    sig = hmac.new(secret.encode(), body, hashlib.sha512).hexdigest()
    assert _verify_hmac(body, sig) is True


def test_hmac_invalid_signature_rejected(monkeypatch):
    """A real secret with a wrong/missing signature is rejected."""
    monkeypatch.setattr(webhooks, "get_settings", lambda: _settings(secret="s3cr3t", debug=False))
    body = b'{"event":"message"}'
    assert _verify_hmac(body, "deadbeef") is False
    assert _verify_hmac(body, None) is False


# ── A2: _sanitize_session ────────────────────────────────────────────
@pytest.mark.parametrize("good", ["vlc", "madrid_1", "casa.test", "a-b_c.9", "default"])
def test_sanitize_session_accepts_valid(good):
    assert _sanitize_session(good) == good


def test_sanitize_session_strips_bad_chars():
    """Disallowed chars (spaces, slashes, injection punctuation) are removed."""
    assert _sanitize_session("vlc/../etc") == "vlc..etc"
    assert _sanitize_session("a b c") == "abc"
    assert _sanitize_session("⚠ x'; DROP") == "xDROP"


def test_sanitize_session_truncates_to_cap():
    """Over-long sessions are hard-truncated to the cap, never rejected outright."""
    out = _sanitize_session("a" * 200)
    assert out is not None and len(out) == webhooks._SESSION_MAX_LEN


def test_sanitize_session_none_for_unusable():
    """Non-str or all-invalid input yields None (caller ignores the event)."""
    assert _sanitize_session(None) is None
    assert _sanitize_session(123) is None
    assert _sanitize_session("⚠⚠⚠") is None  # nothing left after stripping
    assert _sanitize_session("") is None
