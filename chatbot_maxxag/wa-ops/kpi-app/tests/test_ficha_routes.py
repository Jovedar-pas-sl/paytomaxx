"""Route-logic tests for the 'Ficha del día' panel (app/routes/ficha.py).

No DB/LLM/network: the async route functions are called DIRECTLY with the
`queries` / `team` layers and the form payload monkeypatched. They assert the
DECISIONS + side-effects (what gets written, that the sync job is enqueued, that
empty rate rows are dropped, that unchecked toggles persist as False).
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from starlette.datastructures import FormData
from starlette.responses import RedirectResponse

from app import girl_media, queries, team
from app.routes import ficha


_USER = SimpleNamespace(id=1, display_name="Tester")
_KPI = object()  # opaque — every queries.* call is monkeypatched


class _Req:
    """Minimal stand-in: the routes only ever `await request.form()`."""

    def __init__(self, pairs: list[tuple[str, str]]):
        self._fd = FormData(pairs)

    async def form(self) -> FormData:
        return self._fd


async def _noop(*a, **k):
    return None


async def _fake_casa_name(kpi, casa_id):
    return "Casa X"  # stand-in for the _casa_name_or_404 DB lookup


# ── save_girl ────────────────────────────────────────────────────────
async def test_save_girl_parses_and_updates(monkeypatch):
    cap: dict = {}

    async def fake_avail(kpi, casa_id, girl_id, available):
        cap["avail"] = (casa_id, girl_id, available)
        return True

    async def fake_photo(kpi, casa_id, girl_id, send):
        cap["photo"] = (casa_id, girl_id, send)
        return True

    async def fake_details(kpi, casa_id, girl_id, *, hours_today, services, sort_order):
        cap["details"] = {"hours": hours_today, "services": services, "sort": sort_order}
        return True

    monkeypatch.setattr(queries, "set_girl_available", fake_avail)
    monkeypatch.setattr(queries, "set_girl_send_photo", fake_photo)
    monkeypatch.setattr(queries, "update_girl_details", fake_details)

    req = _Req([
        ("available", "on"), ("send_photo", "on"),
        ("hours_today", " 16:00–02:00 "),
        ("services", "GFE, Griego\nBeso negro"),
        ("sort_order", "2"),
    ])
    resp = await ficha.save_girl(7, 42, req, _USER, _KPI)

    assert isinstance(resp, RedirectResponse) and resp.status_code == 303
    assert cap["avail"] == (7, 42, True)
    assert cap["photo"] == (7, 42, True)
    # services split on comma AND newline; hours passed through (route trims in query)
    assert cap["details"]["services"] == ["GFE", "Griego", "Beso negro"]
    assert cap["details"]["sort"] == 2


async def test_save_girl_unchecked_toggles_become_false(monkeypatch):
    cap: dict = {}
    async def fake_avail(kpi, casa_id, girl_id, available):
        cap["avail"] = available
    async def fake_photo(kpi, casa_id, girl_id, send):
        cap["photo"] = send
    monkeypatch.setattr(queries, "set_girl_available", fake_avail)
    monkeypatch.setattr(queries, "set_girl_send_photo", fake_photo)
    monkeypatch.setattr(queries, "update_girl_details", _noop)

    resp = await ficha.save_girl(1, 1, _Req([("hours_today", "")]), _USER, _KPI)
    assert resp.status_code == 303
    assert cap["avail"] is False  # checkbox absent → off
    assert cap["photo"] is False


# ── toggle_available ─────────────────────────────────────────────────
async def test_toggle_available(monkeypatch):
    cap: dict = {}
    async def fake_avail(kpi, casa_id, girl_id, available):
        cap["v"] = (casa_id, girl_id, available)
    monkeypatch.setattr(queries, "set_girl_available", fake_avail)

    resp = await ficha.toggle_available(3, 9, _Req([("to", "on")]), _USER, _KPI)
    assert resp.status_code == 303
    assert cap["v"] == (3, 9, True)


# ── alta / borrado / edición manual (agenda) ─────────────────────────
class _Upload:
    def __init__(self, filename="p.jpg", data=b"\xff\xd8\xff"):
        self.filename = filename
        self._data = data
    async def read(self, n):
        return self._data


async def test_add_girl_creates_manual(monkeypatch):
    cap: dict = {}
    async def fake_insert(kpi, casa_id, **kw):
        cap["casa"] = casa_id
        cap["kw"] = kw
        return 99
    monkeypatch.setattr(queries, "insert_manual_girl", fake_insert)
    monkeypatch.setattr(team, "audit", _noop)
    monkeypatch.setattr(ficha, "_casa_name_or_404", _fake_casa_name)

    req = _Req([
        ("name", " Sofía "), ("age", "24"), ("nationality", "Española"),
        ("services", "GFE, Griego\nBeso negro"), ("hours_today", "16:00–02:00"),
        ("available", "on"), ("send_photo", "on"),
    ])
    resp = await ficha.add_girl(7, req, _USER, _KPI)
    assert resp.status_code == 303
    assert cap["casa"] == 7
    assert cap["kw"]["name"] == "Sofía"
    assert cap["kw"]["age"] == 24
    assert cap["kw"]["services"] == ["GFE", "Griego", "Beso negro"]
    assert cap["kw"]["available_today"] is True and cap["kw"]["send_photo"] is True
    assert cap["kw"]["photo_url"] is None  # sin foto subida


async def test_add_girl_requires_name(monkeypatch):
    called = {"n": 0}
    async def fake_insert(*a, **k):
        called["n"] += 1
    monkeypatch.setattr(queries, "insert_manual_girl", fake_insert)
    monkeypatch.setattr(ficha, "_casa_name_or_404", _fake_casa_name)

    resp = await ficha.add_girl(7, _Req([("name", "   ")]), _USER, _KPI)
    assert resp.status_code == 303
    assert called["n"] == 0  # sin nombre no se crea


async def test_delete_girl_soft_deletes(monkeypatch):
    cap: dict = {}
    async def fake_del(kpi, casa_id, girl_id):
        cap["v"] = (casa_id, girl_id)
        return True
    monkeypatch.setattr(queries, "soft_delete_girl", fake_del)
    monkeypatch.setattr(team, "audit", _noop)

    resp = await ficha.delete_girl(7, 42, _Req([]), _USER, _KPI)
    assert resp.status_code == 303
    assert cap["v"] == (7, 42)


async def test_save_girl_edits_manual_profile_and_photo(monkeypatch):
    cap: dict = {}
    monkeypatch.setattr(queries, "set_girl_available", _noop)
    monkeypatch.setattr(queries, "set_girl_send_photo", _noop)
    monkeypatch.setattr(queries, "update_girl_details", _noop)
    async def fake_profile(kpi, casa_id, girl_id, *, name, age, nationality):
        cap["profile"] = (name, age, nationality)
    async def fake_setphoto(kpi, casa_id, girl_id, url):
        cap["photo"] = url
    async def fake_save(upload):
        return "/media/girls/abc.jpg"
    monkeypatch.setattr(queries, "update_girl_profile", fake_profile)
    monkeypatch.setattr(queries, "set_girl_photo", fake_setphoto)
    monkeypatch.setattr(girl_media, "save_girl_photo", fake_save)

    req = _Req([("name", "Lucía"), ("age", "25"), ("nationality", "Rusa"),
                ("photo", _Upload())])
    resp = await ficha.save_girl(7, 42, req, _USER, _KPI)
    assert resp.status_code == 303
    assert cap["profile"] == ("Lucía", 25, "Rusa")   # perfil editado
    assert cap["photo"] == "/media/girls/abc.jpg"     # foto re-subida


# ── save_rates ───────────────────────────────────────────────────────
async def test_save_rates_builds_items_and_drops_empty(monkeypatch):
    cap: dict = {}
    async def fake_rates(kpi, casa_id, items):
        cap["casa"] = casa_id
        cap["items"] = items
    monkeypatch.setattr(queries, "update_casa_rates", fake_rates)
    monkeypatch.setattr(team, "audit", _noop)
    monkeypatch.setattr(ficha, "_casa_name_or_404", _fake_casa_name)

    req = _Req([
        ("label_es", "1 hora"), ("label_en", "1 hour"), ("price", "150€"),
        ("label_es", "Beso negro"), ("label_en", ""), ("price", "30€"),
        ("label_es", ""), ("label_en", ""), ("price", ""),   # fila vacía → se descarta
    ])
    resp = await ficha.save_rates(7, req, _USER, _KPI)

    assert resp.status_code == 303
    assert cap["casa"] == 7
    assert cap["items"] == [
        {"label_es": "1 hora", "price": "150€", "label_en": "1 hour"},
        {"label_es": "Beso negro", "price": "30€"},  # no label_en key when empty
    ]


# ── mode toggle (Web sync ⇄ Backoffice) ──────────────────────────────
async def test_toggle_mode_on(monkeypatch):
    cap: dict = {}
    async def fake_mode(kpi, casa_id, on):
        cap["v"] = (casa_id, on)
    monkeypatch.setattr(queries, "set_casa_manual_mode", fake_mode)
    monkeypatch.setattr(team, "audit", _noop)
    monkeypatch.setattr(ficha, "_casa_name_or_404", _fake_casa_name)

    resp = await ficha.toggle_mode(5, _Req([("manual", "on")]), _USER, _KPI)
    assert resp.status_code == 303
    assert cap["v"] == (5, True)  # backoffice ON


async def test_toggle_mode_off_when_absent(monkeypatch):
    cap: dict = {}
    async def fake_mode(kpi, casa_id, on):
        cap["v"] = on
    monkeypatch.setattr(queries, "set_casa_manual_mode", fake_mode)
    monkeypatch.setattr(team, "audit", _noop)
    monkeypatch.setattr(ficha, "_casa_name_or_404", _fake_casa_name)

    resp = await ficha.toggle_mode(5, _Req([]), _USER, _KPI)  # checkbox absent → web
    assert resp.status_code == 303
    assert cap["v"] is False


# ── trigger_sync ─────────────────────────────────────────────────────
async def test_trigger_sync_enqueues_job_for_this_casa(monkeypatch):
    cap: dict = {}

    async def fake_name(kpi, casa_id):
        return "Casa X"

    class _Arq:
        async def enqueue_job(self, name, *args):
            cap["job"] = name
            cap["args"] = args

    monkeypatch.setattr(ficha, "_casa_name_or_404", fake_name)
    monkeypatch.setattr(team, "audit", _noop)

    resp = await ficha.trigger_sync(7, _Req([]), _USER, _KPI, _Arq())
    assert resp.status_code == 303
    assert cap["job"] == "website_sync_job"
    assert cap["args"] == (7,)  # non-destructive import scoped to THIS casa
