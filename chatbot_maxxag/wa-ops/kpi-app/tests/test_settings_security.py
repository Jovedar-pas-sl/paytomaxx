"""Security-config tests for app.settings.

Covers the fail-closed webhook-HMAC validator (B1) and the shortened JWT
lifetime default (B3). These run without a real .env — they construct Settings
directly with explicit kwargs.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.settings import Settings

# Minimal set of required fields (Field(...)) so Settings can instantiate.
_BASE_KWARGS = dict(
    DATABASE_URL="postgresql://u:p@db:5432/kpi",
    REDIS_URL="redis://redis:6379/0",
    ANTHROPIC_API_KEY="sk-ant-test",
    JWT_SECRET="test-secret",
    KPI_ADMIN_EMAIL="admin@example.com",
    KPI_ADMIN_PASSWORD_HASH="$2b$12$abc",
    WAHA_API_KEY="waha-key",
)


def _make(**overrides: object) -> Settings:
    return Settings(**{**_BASE_KWARGS, **overrides})  # type: ignore[arg-type]


# ── B1: fail-closed HMAC validation ─────────────────────────────────

def test_empty_hmac_rejected_in_prod() -> None:
    # Arrange / Act / Assert — DEBUG off + no secret must refuse to start.
    with pytest.raises(ValidationError, match="WAHA_WEBHOOK_HMAC"):
        _make(DEBUG=False, WAHA_WEBHOOK_HMAC=None)


def test_blank_hmac_rejected_in_prod() -> None:
    # A whitespace-only secret is treated as empty (still fail-closed).
    with pytest.raises(ValidationError, match="WAHA_WEBHOOK_HMAC"):
        _make(DEBUG=False, WAHA_WEBHOOK_HMAC="   ")


def test_empty_hmac_allowed_in_debug() -> None:
    # In dev (DEBUG=True) an empty secret is tolerated.
    s = _make(DEBUG=True, WAHA_WEBHOOK_HMAC=None)
    assert s.debug is True


def test_present_hmac_allowed_in_prod() -> None:
    # A real secret + prod is the happy path.
    s = _make(DEBUG=False, WAHA_WEBHOOK_HMAC="a" * 64)
    assert s.waha_webhook_hmac is not None
    assert s.waha_webhook_hmac.get_secret_value() == "a" * 64


def test_debug_defaults_to_false() -> None:
    # Fail-closed default: with a secret present, debug is False unless set.
    s = _make(WAHA_WEBHOOK_HMAC="x" * 32)
    assert s.debug is False


# ── B3: short JWT lifetime ──────────────────────────────────────────

def test_jwt_expires_defaults_to_12_hours() -> None:
    s = _make(WAHA_WEBHOOK_HMAC="x" * 32)
    assert s.jwt_expires_hours == 12
