"""WahaClient.request_pairing_code — the 8-char "Link with phone number" flow.

Pins that the client hits the right WAHA endpoint, normalizes the phone to
digits (no '+'/spaces), and returns None WITHOUT raising whenever WAHA can't
issue a code — that None is what keeps the QR fallback path intact in the UI.
No network: httpx MockTransport, mirroring test_media_ssrf.
"""
from __future__ import annotations

import json
import types

import httpx

from app.waha_client import WahaClient


def _client(handler) -> WahaClient:
    settings = types.SimpleNamespace(
        waha_api_url="http://waha:3000",
        waha_api_key=types.SimpleNamespace(get_secret_value=lambda: "k"),
    )
    c = WahaClient(settings)  # type: ignore[arg-type]
    # Swap in a MockTransport so no real HTTP is made.
    c._client = httpx.AsyncClient(
        base_url="http://waha:3000", transport=httpx.MockTransport(handler)
    )
    return c


async def test_returns_code_and_normalizes_phone() -> None:
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"code": "ABCD-WXYZ"})

    c = _client(handler)
    try:
        code = await c.request_pairing_code("vlc-334", "+34 621 033 316")
    finally:
        await c.aclose()

    assert code == "ABCD-WXYZ"
    assert seen["path"] == "/api/vlc-334/auth/request-code"
    assert seen["body"] == {"phoneNumber": "34621033316"}  # digits only


async def test_none_on_error_status() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(422, json={"error": "not available"})

    c = _client(handler)
    try:
        assert await c.request_pairing_code("s", "34600000000") is None
    finally:
        await c.aclose()


async def test_empty_phone_never_calls_waha() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json={"code": "X"})

    c = _client(handler)
    try:
        assert await c.request_pairing_code("s", "   ") is None  # no digits
        assert await c.request_pairing_code("s", "abc") is None
        assert await c.request_pairing_code("s", "") is None
    finally:
        await c.aclose()

    assert calls["n"] == 0  # short-circuits before any HTTP


async def test_none_when_code_field_missing() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"noCode": True})

    c = _client(handler)
    try:
        assert await c.request_pairing_code("s", "34600000000") is None
    finally:
        await c.aclose()


async def test_none_on_non_object_json_body() -> None:
    # A 2xx body that is valid JSON but not an object (bare string / array / null,
    # e.g. from a proxy) must return None, NOT raise AttributeError → 500.
    for payload in ("ABCD-ABCD", [], None):
        def handler(request: httpx.Request, _p=payload) -> httpx.Response:
            return httpx.Response(200, json=_p)

        c = _client(handler)
        try:
            assert await c.request_pairing_code("s", "34600000000") is None
        finally:
            await c.aclose()
