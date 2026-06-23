"""Route-logic tests for the inline-panel copilot routes added this session.

No DB / LLM / network: we call the async route functions DIRECTLY with the
`queries` / `reply_engine` / `team` layers monkeypatched (same approach as
test_auto_reply). They assert the DECISIONS and side-effects:
  * suggest  → generates a draft, stores it as an agent_suggestion, redirects
  * dismiss  → guards ownership, acks the alert, redirects
  * pause    → agent_status=paused_human (+ clears drafts)
  * resume   → agent_status=active (+ acks risk)
  * HX branch → returns the inline embed fragment, not a 303 redirect
  * style refresh → sums per-casa harvest counts and redirects

Template RENDERING is intentionally NOT exercised here (the embed branch is
verified by stubbing conversation_embed) — the embed template is covered by the
Jinja load/render checks in test_agent / the template env.
"""
from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from starlette.requests import Request
from starlette.responses import HTMLResponse, RedirectResponse

from app import queries, team
from app.agent import reply_engine, style_harvest
from app.routes import conversation as conv
from app.routes import style_routes


# ── Lightweight stand-ins ────────────────────────────────────────────
_USER = SimpleNamespace(id=1, display_name="Tester")
_KPI = object()  # opaque — every queries.* call is mocked, so it's never used


def _req(headers: dict | None = None) -> Request:
    raw = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    return Request({"type": "http", "method": "POST", "path": "/", "headers": raw, "query_string": b""})


def _detail(**over):
    base = dict(
        id=42, casa_id=7, casa_name="Maxxage Madrid", contact_name="Cliente",
        contact_phone="34999000111", status="open", waha_session="sess", contact_jid="j@c.us",
    )
    base.update(over)
    return SimpleNamespace(**base)


def _msg(direction: str = "in", body: str = "hola"):
    return SimpleNamespace(
        id=1, body=body, direction=direction, created_at=datetime.now(timezone.utc),
        ack=1, media_url=None, media_mime=None, agent_generated=(direction == "out"),
    )


async def _noop(*a, **k):
    return None


# ── /conversation/{id}/suggest ───────────────────────────────────────
async def test_suggest_generates_stores_and_redirects(monkeypatch):
    captured: dict = {}

    async def fake_detail(kpi, cid):
        return _detail()

    async def fake_msgs(kpi, cid):
        return [_msg("out", "buenas"), _msg("in", "hay chicas esta noche?")]

    async def fake_gen(*a, **k):
        captured["incoming"] = k.get("incoming_text")
        return "claro cariño 😍 mira la web"

    async def fake_supersede(kpi, cid):
        captured["superseded"] = cid
        return 1

    async def fake_insert(kpi, **k):
        captured["alert"] = k

    monkeypatch.setattr(queries, "get_conversation_detail", fake_detail)
    monkeypatch.setattr(queries, "list_messages_for_conversation", fake_msgs)
    monkeypatch.setattr(reply_engine, "generate_reply", fake_gen)
    monkeypatch.setattr(queries, "supersede_pending_suggestions", fake_supersede)
    monkeypatch.setattr(queries, "insert_alert", fake_insert)
    monkeypatch.setattr(team, "audit", _noop)

    resp = await conv.conversation_suggest(42, _req(), _USER, _KPI)

    assert isinstance(resp, RedirectResponse) and resp.status_code == 303
    # used the LAST client message as context, superseded prior drafts, and stored
    # the generated text as a pending agent_suggestion (NOT sent).
    assert captured["incoming"] == "hay chicas esta noche?"
    assert captured["superseded"] == 42
    assert captured["alert"]["type"] == "agent_suggestion"
    assert captured["alert"]["message"] == "claro cariño 😍 mira la web"


async def test_suggest_hx_returns_embed_fragment(monkeypatch):
    """On HX-Request the route returns the embed fragment, not a 303."""

    async def fake_detail(kpi, cid):
        return _detail()

    async def fake_msgs(kpi, cid):
        return [_msg("in", "hola")]

    async def fake_gen(*a, **k):
        return "borrador"

    monkeypatch.setattr(queries, "get_conversation_detail", fake_detail)
    monkeypatch.setattr(queries, "list_messages_for_conversation", fake_msgs)
    monkeypatch.setattr(reply_engine, "generate_reply", fake_gen)
    monkeypatch.setattr(queries, "supersede_pending_suggestions", _noop)
    monkeypatch.setattr(queries, "insert_alert", _noop)
    monkeypatch.setattr(team, "audit", _noop)

    sentinel = HTMLResponse("<embed/>")

    async def fake_embed(cid, request, user, kpi):
        return sentinel

    monkeypatch.setattr(conv, "conversation_embed", fake_embed)

    resp = await conv.conversation_suggest(42, _req({"HX-Request": "true"}), _USER, _KPI)
    assert resp is sentinel  # HX branch → embed fragment, not RedirectResponse


# ── /conversation/{id}/dismiss-suggestion/{alert_id} ─────────────────
async def test_dismiss_rejects_alert_from_other_conversation(monkeypatch):
    async def fake_alert(kpi, aid):
        return SimpleNamespace(type="agent_suggestion", conversation_id=999)  # not 42

    monkeypatch.setattr(queries, "get_alert", fake_alert)
    with pytest.raises(HTTPException) as ei:
        await conv.conversation_dismiss_suggestion(42, 5, _req(), _USER, _KPI)
    assert ei.value.status_code == 404


async def test_dismiss_acks_and_redirects(monkeypatch):
    acked: dict = {}

    async def fake_alert(kpi, aid):
        return SimpleNamespace(type="agent_suggestion", conversation_id=42)

    async def fake_ack(kpi, aid):
        acked["id"] = aid
        return True

    monkeypatch.setattr(queries, "get_alert", fake_alert)
    monkeypatch.setattr(queries, "ack_alert", fake_ack)
    monkeypatch.setattr(team, "audit", _noop)

    resp = await conv.conversation_dismiss_suggestion(42, 5, _req(), _USER, _KPI)
    assert resp.status_code == 303
    assert acked["id"] == 5  # acked WITHOUT sending


# ── pause / resume ───────────────────────────────────────────────────
async def test_agent_pause_sets_paused_human_and_clears_drafts(monkeypatch):
    calls: dict = {}

    async def fake_set(kpi, cid, status):
        calls["status"] = status

    async def fake_ackall(kpi, cid):
        calls["ackall"] = True
        return 0

    monkeypatch.setattr(queries, "set_conversation_agent_status", fake_set)
    monkeypatch.setattr(queries, "ack_all_suggestions", fake_ackall)
    monkeypatch.setattr(team, "audit", _noop)

    resp = await conv.conversation_agent_pause(42, _req(), _USER, _KPI)
    assert resp.status_code == 303
    assert calls == {"status": "paused_human", "ackall": True}


async def test_agent_resume_sets_active_and_acks_risk(monkeypatch):
    calls: dict = {}

    async def fake_set(kpi, cid, status):
        calls["status"] = status

    async def fake_risk(kpi, cid):
        calls["risk"] = True

    monkeypatch.setattr(queries, "set_conversation_agent_status", fake_set)
    monkeypatch.setattr(queries, "ack_risk_alerts", fake_risk)
    monkeypatch.setattr(team, "audit", _noop)

    resp = await conv.conversation_agent_resume(42, _req(), _USER, _KPI)
    assert resp.status_code == 303
    assert calls == {"status": "active", "risk": True}


# ── /ajustes/estilo/refresh ──────────────────────────────────────────
async def test_style_refresh_sums_per_casa_and_redirects(monkeypatch):
    async def fake_casas(kpi):
        return [SimpleNamespace(account_id=1), SimpleNamespace(account_id=2)]

    async def fake_harvest(kpi, cid):
        return 3  # 2 casas × 3 = 6 new candidates

    monkeypatch.setattr(queries, "list_casas", fake_casas)
    monkeypatch.setattr(style_harvest, "harvest_casa", fake_harvest)

    resp = await style_routes.refresh_examples(_USER, _KPI)
    assert resp.status_code == 303
    assert "6" in resp.headers["location"]  # "6 respuestas nuevas…"


async def test_style_refresh_no_new_candidates(monkeypatch):
    async def fake_casas(kpi):
        return [SimpleNamespace(account_id=1)]

    async def fake_harvest(kpi, cid):
        return 0

    monkeypatch.setattr(queries, "list_casas", fake_casas)
    monkeypatch.setattr(style_harvest, "harvest_casa", fake_harvest)

    resp = await style_routes.refresh_examples(_USER, _KPI)
    assert resp.status_code == 303
    assert "ok=" in resp.headers["location"]  # success message, not error
