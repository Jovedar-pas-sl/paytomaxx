"""Unit tests for the website->DB sync (pure helpers + the roster-wipe guard).

Covers the two adversarial-review regressions:
  * wpjson availability serialized as strings ("0"/"false") must NOT become True.
  * a non-empty-but-unusable girls feed must yield ext_ids == [] so the caller's
    `if ext_ids` guard skips the full-roster deactivation (CRITICAL roster wipe).
"""
from __future__ import annotations

from app.agent import website_sync as ws


# ── _safe_int ────────────────────────────────────────────────────────
def test_safe_int():
    assert ws._safe_int("20") == 20
    assert ws._safe_int(19) == 19
    assert ws._safe_int("  21 ") == 21
    assert ws._safe_int("veinte") is None
    assert ws._safe_int(None) is None


# ── _as_bool (HIGH regression) ───────────────────────────────────────
def test_as_bool_string_falsey_is_false():
    assert ws._as_bool(True) is True
    assert ws._as_bool(False) is False
    assert ws._as_bool("0") is False        # was True with raw bool()
    assert ws._as_bool("false") is False    # was True with raw bool()
    assert ws._as_bool("") is False
    assert ws._as_bool(None) is False
    assert ws._as_bool("1") is True
    assert ws._as_bool("true") is True
    assert ws._as_bool(1) is True


# (test_abs_photo removed — the lenient _abs_photo was replaced by the hardened
#  _safe_photo_url; see its SSRF-guard tests below.)


# ── _girls_container ─────────────────────────────────────────────────
def test_girls_container():
    assert ws._girls_container("chatbot", [{"id": 1}]) == [{"id": 1}]
    assert ws._girls_container("chatbot", {"girls": []}) is None
    assert ws._girls_container("wpjson", {"girls": [{"id": 1}]}) == [{"id": 1}]
    assert ws._girls_container("wpjson", [{"id": 1}]) is None
    assert ws._girls_container("wpjson", {"x": 1}) is None


# ── normalizers ──────────────────────────────────────────────────────
def test_normalize_chatbot():
    g = ws._normalize_chatbot("https://x.com", {
        "id": "esc_a", "name": "Ana", "age": "20", "nationality": "Española",
        "tagline": "hola", "services": ["Atención a parejas", "Francés"],
        "photo": "/u/a.webp",
    })
    assert g["ext_id"] == "esc_a"
    assert g["age"] == 20
    assert g["description"] == "hola"
    assert g["photo_url"] == "https://x.com/u/a.webp"
    assert g["available_today"] is True
    assert g["escort_pareja"] is True
    assert ws._normalize_chatbot("https://x.com", {"name": "noid"}) is None


def test_normalize_wpjson_availability_from_string():
    # photo_url host now MUST match the casa website domain (M2), so use the same
    # host as the base_url; cross-host / non-https drops are covered separately.
    g = ws._normalize_wpjson("https://x.com", {
        "id": "9", "name": "Bea", "age": 24, "nationality": "Cubana",
        "description": "d", "photo_url": "https://x.com/b.jpg",
        "available_today": "0", "outcall": "false", "languages": ["ES"],
        "services": [],
    })
    assert g["available_today"] is False   # "0" must NOT be truthy
    assert g["outcall"] is False
    assert g["photo_url"] == "https://x.com/b.jpg"
    assert g["languages"] == ["ES"]
    assert ws._normalize_wpjson("https://x.com", {"name": "noid"}) is None


# ── M2 SSRF guard: photo_url host/scheme validation ──────────────────
def test_safe_photo_url_keeps_same_host_https():
    """Same-host https URL (and a subdomain CDN of the same apex) is kept."""
    assert ws._safe_photo_url("https://x.com", "https://x.com/u/p.jpg") == "https://x.com/u/p.jpg"
    assert ws._safe_photo_url("https://x.com", "https://cdn.x.com/p.jpg") == "https://cdn.x.com/p.jpg"
    # www on the site host is normalized to the apex.
    assert ws._safe_photo_url("https://www.x.com", "https://x.com/p.jpg") == "https://x.com/p.jpg"


def test_safe_photo_url_relative_absolutizes_to_site():
    """A site-root-relative path absolutizes to the (https) casa host → kept."""
    assert ws._safe_photo_url("https://x.com", "/u/p.jpg") == "https://x.com/u/p.jpg"


def test_safe_photo_url_drops_cross_host():
    """A different host (classic stored-SSRF vector) is dropped → None."""
    assert ws._safe_photo_url("https://x.com", "https://evil.com/p.jpg") is None
    assert ws._safe_photo_url("https://x.com", "https://cdn.evil.com/p.jpg") is None


def test_safe_photo_url_drops_non_https_schemes():
    """file:// / http:// / internal-metadata URLs that WAHA would fetch are dropped."""
    assert ws._safe_photo_url("https://x.com", "file:///etc/passwd") is None
    assert ws._safe_photo_url("https://x.com", "http://x.com/p.jpg") is None  # not https
    assert ws._safe_photo_url("https://x.com", "http://169.254.169.254/latest/meta-data") is None


def test_safe_photo_url_drops_empty():
    assert ws._safe_photo_url("https://x.com", "") is None
    assert ws._safe_photo_url("https://x.com", None) is None


def test_normalize_chatbot_drops_offsite_photo():
    """The chatbot flavor's relative photo absolutizes to the casa host (kept),
    but a non-string / off-site value drops to None."""
    g = ws._normalize_chatbot("https://x.com", {
        "id": "a", "name": "Ana", "photo": "/u/a.webp",
    })
    assert g["photo_url"] == "https://x.com/u/a.webp"
    g2 = ws._normalize_chatbot("https://x.com", {
        "id": "b", "name": "Bea", "photo": "https://evil.com/x.jpg",
    })
    assert g2["photo_url"] is None


# ── CRITICAL regression: unusable feed → no ext_ids → no wipe ────────
async def test_sync_girls_unusable_feed_yields_no_ext_ids(monkeypatch):
    """A non-empty feed whose rows are all unusable (non-dict / no id) must
    produce ext_ids == [] so the caller's `if ext_ids` guard skips the
    full-roster deactivation."""
    calls: list[str] = []

    async def _fake_upsert(pool, **kw):
        calls.append(kw["ext_id"])

    monkeypatch.setattr(ws.queries, "upsert_girl_from_sync", _fake_upsert)

    girls = [{"name": "no id"}, "not a dict", {"foo": "bar"}]
    upserted, ext_ids = await ws._sync_girls(
        None, 1, "https://x.com", "wpjson", ws._normalize_wpjson, girls,
    )
    assert upserted == 0
    assert ext_ids == []
    assert calls == []


async def test_sync_config_chatbot_flavor_reads_address_from_location(monkeypatch):
    """chatbot flavor nests hours/address/maps under `location` (schedule is null).
    The address MUST still reach casa_profile — else Sara wrongly says she only
    knows the city."""
    captured: dict = {}

    async def _fake_upsert(pool, **kw):
        captured.update(kw)

    monkeypatch.setattr(ws.queries, "upsert_casa_profile_from_sync", _fake_upsert)
    config = {
        "site": {"bot_name": "Sara"},
        "schedule": None,  # chatbot flavor sends the schedule under `location`
        "location": {
            "hours_es": "24h",
            "address_es": "C. Joaquín Costa, 44, Valencia",
            "maps_url": "https://maps.example/vlc",
        },
        "rates": {},
    }
    await ws._sync_config(object(), casa_id=7, config=config)
    assert captured["address"] == "C. Joaquín Costa, 44, Valencia"
    assert captured["maps_url"] == "https://maps.example/vlc"
    assert captured["schedule"]["hours_es"] == "24h"


async def test_sync_config_wpjson_flavor_still_reads_schedule(monkeypatch):
    """wpjson flavor keeps nesting under `schedule` — the fallback must not break it."""
    captured: dict = {}

    async def _fake_upsert(pool, **kw):
        captured.update(kw)

    monkeypatch.setattr(ws.queries, "upsert_casa_profile_from_sync", _fake_upsert)
    config = {
        "site": {},
        "schedule": {"hours_es": "24h", "address_es": "C. Félix Boix 9", "maps_url": "u"},
        "rates": {},
    }
    await ws._sync_config(object(), casa_id=7, config=config)
    assert captured["address"] == "C. Félix Boix 9"
