"""SSRF / API-key-leak guard tests for media fetching (Group A: A5 / M1).

open_media_stream carries the X-Api-Key header, so it must NEVER fetch the
stored URL's host. The fix routes by PATH only: whatever host a stored media_url
carries (attacker, cloud-metadata, or WAHA's own localhost), only its path is
taken and fetched against the configured WAHA base_url. These tests pin that
down via the pure `_media_path` helper plus one request-build assertion — no
network call is made.
"""
from __future__ import annotations

import types

import pytest

from app.waha_client import WahaClient, _media_path


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        # Absolute URLs: the host is discarded, only the path (+query) is kept,
        # so the fetch targets the WAHA base — an external/metadata host is never
        # contacted (SSRF + key-leak closed).
        ("http://evil.com/api/files/x", "/api/files/x"),
        ("http://169.254.169.254/latest/meta-data", "/latest/meta-data"),
        ("https://waha:3000/api/files/x.jpg", "/api/files/x.jpg"),
        ("http://localhost:3000/api/files/x.jpg", "/api/files/x.jpg"),  # WAHA self-host
        ("http://evil.com/api/files/x?token=abc", "/api/files/x?token=abc"),  # query kept
        # Relative path resolves against base_url unchanged.
        ("/api/files/x.jpg", "/api/files/x.jpg"),
    ],
)
def test_media_path_keeps_only_path(url, expected):
    assert _media_path(url) == expected


async def test_open_media_request_targets_waha_base_not_stored_host():
    """A poisoned external host is never contacted: the built request resolves
    against the WAHA base_url, not the attacker host."""
    settings = types.SimpleNamespace(
        waha_api_url="http://waha:3000",
        waha_api_key=types.SimpleNamespace(get_secret_value=lambda: "k"),
    )
    c = WahaClient(settings)  # type: ignore[arg-type]
    try:
        req = c._client.build_request("GET", _media_path("http://evil.com/api/files/x"))
        assert str(req.url) == "http://waha:3000/api/files/x"  # WAHA, never evil.com
        assert req.headers.get("X-Api-Key") == "k"  # key only ever sent to WAHA
    finally:
        await c.aclose()
