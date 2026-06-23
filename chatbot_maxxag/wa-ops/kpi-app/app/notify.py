"""Best-effort push notifications (Telegram) for critical ops events.

FAIL-SOFT by design: a no-op when TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are
unset, and it NEVER raises — a notify failure must never break the caller
(webhook ingestion, the auto-reply job, etc.).

Use for events the app itself can DETECT (WhatsApp session down, Sara
auto-protección). For "the whole app/VPS is down" use an EXTERNAL monitor
(UptimeRobot/Healthchecks on /health) — a dead app cannot notify itself.
"""
from __future__ import annotations

import logging

import httpx

from app.settings import get_settings

logger = logging.getLogger("notify")

_TIMEOUT_S = 8.0
_MAX_LEN = 4000  # Telegram hard limit is 4096


async def push_alert(text: str) -> bool:
    """Send a Telegram message to the configured chat.

    Returns True if sent, False if unconfigured OR on any error (logged, never
    raised). Safe to `await` from a request handler or a worker job.
    """
    try:
        s = get_settings()
        token = s.telegram_bot_token.get_secret_value() if s.telegram_bot_token else ""
        chat_id = s.telegram_chat_id
        if not token or not chat_id:
            return False  # not configured → silent no-op
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as http:
            resp = await http.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json={
                    "chat_id": chat_id,
                    "text": text[:_MAX_LEN],
                    "disable_web_page_preview": True,
                },
            )
            resp.raise_for_status()
        return True
    except Exception as exc:  # noqa: BLE001 — notify must never break the caller
        logger.warning("notify.push_alert failed: %s", exc)
        return False
