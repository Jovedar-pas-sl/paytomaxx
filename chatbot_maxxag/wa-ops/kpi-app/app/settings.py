"""Application settings loaded from environment variables."""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Database URLs
    database_url: str = Field(..., alias="DATABASE_URL")
    redis_url: str = Field(..., alias="REDIS_URL")

    # Claude
    anthropic_api_key: SecretStr = Field(..., alias="ANTHROPIC_API_KEY")
    claude_model: str = Field("claude-haiku-4-5", alias="CLAUDE_MODEL")

    # Auth
    jwt_secret: SecretStr = Field(..., alias="JWT_SECRET")
    jwt_algorithm: str = "HS256"
    jwt_expires_hours: int = 24 * 30  # 30 days

    kpi_admin_email: str = Field(..., alias="KPI_ADMIN_EMAIL")
    kpi_admin_password_hash: SecretStr = Field(..., alias="KPI_ADMIN_PASSWORD_HASH")

    # WAHA (WhatsApp bridge; replaces Evolution)
    waha_api_url: str = Field("http://waha:3000", alias="WAHA_API_URL")
    waha_api_key: SecretStr = Field(..., alias="WAHA_API_KEY")
    # Shared secret for WAHA → KPI webhook HMAC. Empty string disables check (dev only).
    waha_webhook_hmac: SecretStr | None = Field(None, alias="WAHA_WEBHOOK_HMAC")

    # Role — "web" or "worker" (set by docker-compose)
    role: str = Field("web", alias="ROLE")

    # Login rate limit (fails per 5-min window per IP before ban)
    login_rate_max_fails: int = Field(10, alias="LOGIN_RATE_MAX_FAILS")
    login_rate_window_seconds: int = Field(300, alias="LOGIN_RATE_WINDOW_SECONDS")

    # Public domain (used for links from KPI app to Chatwoot admin panel)
    domain: str = Field("", alias="DOMAIN")

    # Cookie security: True in production (HTTPS), False for local HTTP demo
    cookie_secure: bool = Field(True, alias="COOKIE_SECURE")


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
