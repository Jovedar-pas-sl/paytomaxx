"""Authentication: bcrypt verify + JWT cookie issuance."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import bcrypt
import jwt

from app.settings import get_settings


def verify_password(plaintext: str, stored_hash: str) -> bool:
    """Verify a password against its bcrypt hash."""
    try:
        return bcrypt.checkpw(plaintext.encode("utf-8"), stored_hash.encode("utf-8"))
    except ValueError:
        # Malformed hash
        return False


def hash_password(plaintext: str) -> str:
    """Hash a plaintext password with bcrypt (for new users / resets)."""
    return bcrypt.hashpw(plaintext.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def create_token(email: str, *, uid: int | None = None, role: str | None = None) -> str:
    """Issue a JWT for a user. `uid`/`role` are hints; the DB stays the source
    of truth (get_current_user re-fetches), so a deactivated or re-roled user is
    reflected on the next request regardless of what the cookie claims."""
    s = get_settings()
    now = datetime.now(UTC)
    claims: dict[str, Any] = {
        "sub": email,
        "iat": now,
        "exp": now + timedelta(hours=s.jwt_expires_hours),
    }
    if uid is not None:
        claims["uid"] = uid
    if role is not None:
        claims["role"] = role
    return jwt.encode(
        claims,
        s.jwt_secret.get_secret_value(),
        algorithm=s.jwt_algorithm,
    )


def decode_token(token: str) -> dict[str, Any]:
    """Decode + verify a JWT. Raises jwt.InvalidTokenError on failure."""
    s = get_settings()
    return jwt.decode(
        token,
        s.jwt_secret.get_secret_value(),
        algorithms=[s.jwt_algorithm],
    )
