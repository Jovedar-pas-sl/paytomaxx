"""Application settings loaded from environment variables."""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Database URLs
    database_url: str = Field(..., alias="DATABASE_URL")
    redis_url: str = Field(..., alias="REDIS_URL")

    # Claude
    anthropic_api_key: SecretStr = Field(..., alias="ANTHROPIC_API_KEY")
    claude_model: str = Field("claude-haiku-4-5", alias="CLAUDE_MODEL")
    # Pricing per million tokens (USD). Update if Anthropic changes them.
    # Defaults are claude-haiku-4-5 list price as of 2026-Q2.
    claude_price_input_per_mtok: float = Field(0.80, alias="CLAUDE_PRICE_INPUT_PER_MTOK")
    claude_price_output_per_mtok: float = Field(4.0, alias="CLAUDE_PRICE_OUTPUT_PER_MTOK")

    # Auth
    jwt_secret: SecretStr = Field(..., alias="JWT_SECRET")
    jwt_algorithm: str = "HS256"
    # Short-lived sessions by default (12h); tune via env. Shorter = smaller
    # window for a captured token on a panel with client PII + WhatsApp send.
    jwt_expires_hours: int = Field(12, alias="JWT_EXPIRES_HOURS")

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

    # Dev flag: ONLY when True is the empty webhook-HMAC bypass allowed. Default
    # False → production must configure WAHA_WEBHOOK_HMAC (see validator below).
    debug: bool = Field(False, alias="DEBUG")

    # Push alerts (Telegram) for critical ops events — optional; the notifier
    # no-ops when unset (see app/notify.py).
    telegram_bot_token: SecretStr | None = Field(None, alias="TELEGRAM_BOT_TOKEN")
    telegram_chat_id: str = Field("", alias="TELEGRAM_CHAT_ID")

    @model_validator(mode="after")
    def _require_webhook_hmac_in_prod(self) -> "Settings":
        """FAIL-CLOSED: in production (DEBUG=false) the WAHA webhook secret MUST be
        set, otherwise /webhook/waha would accept unauthenticated requests (anyone
        could make Sara message real clients). Set WAHA_WEBHOOK_HMAC, or DEBUG=true
        for local dev."""
        if not self.debug:
            secret = self.waha_webhook_hmac.get_secret_value() if self.waha_webhook_hmac else ""
            if not secret.strip():
                raise ValueError(
                    "WAHA_WEBHOOK_HMAC must be set when DEBUG is false (production)."
                )
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
