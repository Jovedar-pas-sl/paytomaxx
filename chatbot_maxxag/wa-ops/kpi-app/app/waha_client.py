"""Thin async HTTP client for WAHA (WhatsApp HTTP API).

Lifecycle is owned by the FastAPI app: one instance created in `lifespan`,
closed on shutdown. Use `WahaDep` from `deps.py` to inject in routes.

Docs: https://waha.devlike.pro/docs
"""
from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

import httpx

from app.settings import Settings


def _media_path(url: str) -> str:
    """Return ONLY the path (+query) of a (possibly absolute) media URL.

    SSRF / API-key-leak guard: open_media_stream carries the WAHA X-Api-Key, so
    it must NEVER fetch a stored URL's HOST (attacker, cloud-metadata, or WAHA's
    own localhost). Routing by PATH means the fetch always targets the configured
    WAHA base_url regardless of the stored host. A relative path passes through
    unchanged.
    """
    parts = urlsplit(url or "")
    path = parts.path or "/"
    return f"{path}?{parts.query}" if parts.query else path


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

    async def get_qr_image_bytes(self, name: str) -> bytes | None:
        """Returns the raw PNG bytes of the QR. None if session not in SCAN_QR_CODE state."""
        r = await self._client.get(f"/api/{name}/auth/qr", params={"format": "image"})
        if r.status_code in (404, 422):
            return None
        r.raise_for_status()
        return r.content

    async def request_pairing_code(self, name: str, phone: str) -> str | None:
        """Request an 8-char pairing code ('ABCD-ABCD') so a number can be linked by
        TYPING the code into WhatsApp → Dispositivos vinculados → 'Vincular con
        número de teléfono' — no QR scan, no second device (ideal when the owner
        has a single phone).

        `phone` is normalized to digits + country code, no '+'. The session must
        already be started (SCAN_QR_CODE) before the code is issued; on success it
        transitions to WORKING. Returns None whenever WAHA can't issue a code —
        NOWEB's pairing-code auth is documented as *not always available* (see
        WAHA docs / GH #1385), which is exactly why the QR stays as the mandatory
        fallback and this never raises into the request flow.
        """
        digits = "".join(ch for ch in (phone or "") if ch.isdigit())
        if not digits:
            return None
        try:
            r = await self._client.post(
                f"/api/{name}/auth/request-code",
                json={"phoneNumber": digits},
            )
        except httpx.HTTPError:
            return None
        if not r.is_success:
            return None
        try:
            body = r.json()
        except ValueError:  # non-JSON body
            return None
        # A 2xx body that is valid JSON but not an object (bare string, array,
        # null — e.g. from a proxy/error page) must NOT raise: keep the QR
        # fallback intact instead of 500ing the request.
        code = body.get("code") if isinstance(body, dict) else None
        return code or None

    # ── Messages ──────────────────────────────────────────────────
    async def send_text(self, session: str, chat_id: str, text: str) -> dict[str, Any]:
        r = await self._client.post(
            "/api/sendText",
            json={"session": session, "chatId": chat_id, "text": text},
        )
        r.raise_for_status()
        return r.json()

    async def send_image(
        self, session: str, chat_id: str, image_url: str, caption: str
    ) -> dict[str, Any]:
        """Send an image by URL with a caption (mirrors `send_text`).

        WAHA's NOWEB engine downloads the file from `image_url` server-side, so we
        pass it as `{"file": {"url": image_url}}`. Like `send_text` this RAISES on
        a non-2xx (it does NOT swallow errors like the presence helpers): the
        caller persists the message only after a successful send, so propagation
        keeps the anti-ban counters and the DB honest.
        """
        r = await self._client.post(
            "/api/sendImage",
            json={
                "session": session,
                "chatId": chat_id,
                "file": {"url": image_url},
                "caption": caption,
            },
        )
        r.raise_for_status()
        return r.json()

    async def send_location(
        self,
        session: str,
        chat_id: str,
        latitude: float,
        longitude: float,
        title: str,
    ) -> dict[str, Any]:
        """Send a location pin (mirrors `send_text`; raises on non-2xx).

        Added now for later use (e.g. sending the casa address); the agent wires
        PHOTOS in this task, not location.
        """
        r = await self._client.post(
            "/api/sendLocation",
            json={
                "session": session,
                "chatId": chat_id,
                "latitude": latitude,
                "longitude": longitude,
                "title": title,
            },
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

        SSRF-safe: only the PATH of `url` is used (see `_media_path`); the request
        is always built against the client's WAHA base_url, so the X-Api-Key
        header is NEVER sent to a stored URL's host (attacker / metadata / etc.).
        Caller consumes the body (e.g. via StreamingResponse) and closes it.
        """
        req = self._client.build_request("GET", _media_path(url))
        return await self._client.send(req, stream=True)
