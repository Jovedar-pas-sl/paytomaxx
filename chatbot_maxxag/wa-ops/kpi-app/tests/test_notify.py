"""notify.push_alert must be FAIL-SOFT: when Telegram is unconfigured (or the
settings can't even load), it returns False and NEVER raises — a notify failure
must never break the worker/webhook that calls it."""
from __future__ import annotations

import types

import app.notify as notify


async def test_push_alert_noop_when_unconfigured(monkeypatch) -> None:
    # No token/chat configured → silent no-op, returns False, no network, no raise.
    fake = types.SimpleNamespace(telegram_bot_token=None, telegram_chat_id="")
    monkeypatch.setattr(notify, "get_settings", lambda: fake)
    assert await notify.push_alert("hola") is False


async def test_push_alert_never_raises_on_bad_settings(monkeypatch) -> None:
    # Even if settings blow up, push_alert swallows it and returns False.
    def _boom():
        raise RuntimeError("no env")

    monkeypatch.setattr(notify, "get_settings", _boom)
    assert await notify.push_alert("hola") is False


async def test_push_alert_sends_when_configured(monkeypatch) -> None:
    # Configured → posts to the Telegram API and returns True. httpx is stubbed
    # so no real network call happens.
    fake = types.SimpleNamespace(
        telegram_bot_token=types.SimpleNamespace(get_secret_value=lambda: "TOK"),
        telegram_chat_id="123",
    )
    monkeypatch.setattr(notify, "get_settings", lambda: fake)

    sent: dict = {}

    class _Resp:
        def raise_for_status(self) -> None:
            return None

    class _Client:
        def __init__(self, *a, **k) -> None: ...
        async def __aenter__(self):
            return self
        async def __aexit__(self, *a) -> None:
            return None
        async def post(self, url, json):  # noqa: A002 — mirror httpx signature
            sent["url"] = url
            sent["json"] = json
            return _Resp()

    monkeypatch.setattr(notify.httpx, "AsyncClient", _Client)
    ok = await notify.push_alert("caído")
    assert ok is True
    assert "/botTOK/sendMessage" in sent["url"]
    assert sent["json"]["chat_id"] == "123"
    assert sent["json"]["text"] == "caído"
