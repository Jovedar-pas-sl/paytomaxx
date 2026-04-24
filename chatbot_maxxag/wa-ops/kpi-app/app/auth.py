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


def create_token(email: str) -> str:
    """Issue a JWT for the given admin email."""
    s = get_settings()
    now = datetime.now(UTC)
    claims = {
        "sub": email,
        "iat": now,
        "exp": now + timedelta(hours=s.jwt_expires_hours),
    }
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
