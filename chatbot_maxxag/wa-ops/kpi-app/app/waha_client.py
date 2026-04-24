"""Thin async HTTP client for WAHA (WhatsApp HTTP API).

Lifecycle is owned by the FastAPI app: one instance created in `lifespan`,
closed on shutdown. Use `WahaDep` from `deps.py` to inject in routes.

Docs: https://waha.devlike.pro/docs
"""
from __future__ import annotations

from typing import Any

import httpx

from app.settings import Settings


class WahaClient:
    """Async wrapper around the subset of WAHA endpoints we use."""

    def __init__(self, settings: Settings) -> None:
        self._client = httpx.AsyncClient(
            base_url=settings.waha_api_url,
            headers={"X-Api-Key": settings.waha_api_key.get_secret_value()},
            timeout=30.0,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    # ── Sessions ──────────────────────────────────────────────────
    async def list_sessions(self, *, include_stopped: bool = True) -> list[dict[str, Any]]:
        params = {"all": "true"} if include_stopped else {}
        r = await self._client.get("/api/sessions", params=params)
        r.raise_for_status()
        return r.json()

    async def get_session(self, name: str) -> dict[str, Any]:
        r = await self._client.get(f"/api/sessions/{name}")
        r.raise_for_status()
        return r.json()

    async def create_session(self, name: str, *, start: bool = True) -> dict[str, Any]:
        r = await self._client.post("/api/sessions", json={"name": name, "start": start})
        r.raise_for_status()
        return r.json()

    async def start_session(self, name: str) -> dict[str, Any]:
        r = await self._client.post(f"/api/sessions/{name}/start")
        r.raise_for_status()
        return r.json()

    async def stop_session(self, name: str) -> None:
        r = await self._client.post(f"/api/sessions/{name}/stop")
        r.raise_for_status()

    async def logout_session(self, name: str) -> None:
        r = await self._client.post(f"/api/sessions/{name}/logout")
        r.raise_for_status()

    async def get_qr(self, name: str) -> str | None:
        r = await self._client.get(f"/api/{name}/auth/qr", params={"format": "raw"})
        if r.status_code in (404, 422):
            return None
        r.raise_for_status()
        return r.json().get("value")

    # ── Messages ──────────────────────────────────────────────────
    async def send_text(self, session: str, chat_id: str, text: str) -> dict[str, Any]:
        r = await self._client.post(
            "/api/sendText",
            json={"session": session, "chatId": chat_id, "text": text},
        )
        r.raise_for_status()
        return r.json()

    async def mark_read(self, session: str, chat_id: str) -> None:
        try:
            r = await self._client.post(f"/api/{session}/chats/{chat_id}/messages/read")
            r.raise_for_status()
        except httpx.HTTPStatusError:
            pass

    async def start_typing(self, session: str, chat_id: str) -> None:
        try:
            r = await self._client.post(
                f"/api/{session}/presence",
                json={"chatId": chat_id, "presence": "typing"},
            )
            r.raise_for_status()
        except httpx.HTTPStatusError:
            pass

    # ── Media ─────────────────────────────────────────────────────
    async def open_media_stream(self, url: str) -> httpx.Response:
        """Open a streaming response to a WAHA media URL.

        WAHA media URLs require the API key header. Caller is responsible
        for consuming the body (e.g., via StreamingResponse) and closing.
        Accepts both absolute URLs (http://waha:3000/...) and relative ones.
        """
        # Normalize to path relative to client's base_url so base_url + headers apply
        path = url
        base = str(self._client.base_url).rstrip("/")
        if url.startswith(base):
            path = url[len(base):] or "/"
        req = self._client.build_request("GET", path)
        return await self._client.send(req, stream=True)
