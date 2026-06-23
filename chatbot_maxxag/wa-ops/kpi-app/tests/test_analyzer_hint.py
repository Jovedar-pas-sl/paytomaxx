"""Tests for the analyzer→Sara soft-hint injection.

Two layers, both pure / mocked (no DB / LLM / network):
  * `persona.build_hint_block` — pure: enum→instruction mapping, localized
    internal label, soft never-quote phrasing, and the "no hint" cases.
  * `reply_engine.generate_reply` — mocks `queries.get_latest_analysis_hint`
    (the DB) and `reply_engine._call_text` (the Claude call) to assert:
      (a) a present hint is injected into the `system` prompt passed to Claude
          and is labelled internal / never-quote;
      (b) when the query returns None the `system` prompt is byte-for-byte the
          same as the no-hint baseline (fail-soft, opt-in);
      (c) a query/format exception does not propagate — generate_reply still
          returns a (fallback or normal) reply.
"""
from __future__ import annotations

import pytest

from app.agent import persona, reply_engine
from app.agent.reply_engine import generate_reply
from app.queries import AnalysisHint, CasaKnowledge, CasaProfileRow, GirlRow


# ── Fixtures mirroring test_agent.py's **over override pattern ────────
def _profile(**over) -> CasaProfileRow:
    base = dict(
        casa_id=1, casa_name="Maxxage Valencia", bot_name="Sara",
        default_lang="es", whatsapp_recepcion="+34603201414",
        telegram_recepcion="@maxxagvlc", greetings={},
        rates={"items": [{"label_es": "1 hora", "price": "150€"}]},
        schedule={"hours_es": "24h"}, faqs=[], outcall={},
        address="C. Joaquín Costa 44", address_lat=None, address_lng=None,
        maps_url=None,
    )
    base.update(over)
    return CasaProfileRow(**base)


def _girl(**over) -> GirlRow:
    base = dict(
        id=1, casa_id=1, ext_id="vlc1", name="Sophia", age=24,
        nationality="Española", description="Morena de ojos verdes",
        photo_url=None, whatsapp="+34600000001", available_today=True,
        outcall=True, escort_pareja=False, services=["GFE"], languages=["ES"],
    )
    base.update(over)
    return GirlRow(**base)


# ── persona.build_hint_block (pure) ───────────────────────────────────
def test_hint_block_translates_enum_to_natural_instruction():
    block = persona.build_hint_block("close_booking", "cliente listo", "es")
    assert "PISTA INTERNA" in block
    assert "cerrar la reserva" in block          # natural-language, not the code
    assert "close_booking" not in block          # raw enum code never dumped
    assert "motivo: cliente listo" in block


def test_hint_block_is_soft_and_never_quote():
    block = persona.build_hint_block("send_price", None, "es")
    # Soft: she MAY follow it, not forced.
    assert "Síguela solo si" in block
    assert "no estás obligada" in block
    # Internal: explicitly never mention/quote to the client.
    assert "NUNCA la menciones" in block


def test_hint_block_without_reason_omits_motive():
    block = persona.build_hint_block("ask_availability", None, "es")
    assert "preguntarle qué día u hora" in block
    assert "motivo:" not in block


@pytest.mark.parametrize("action", ["escalate_human", "ignore_spam", "none"])
def test_hint_block_empty_for_non_actionable(action):
    assert persona.build_hint_block(action, "x", "es") == ""


def test_hint_block_empty_for_missing_or_unknown_action():
    assert persona.build_hint_block(None, "x", "es") == ""
    assert persona.build_hint_block("not_a_real_action", "x", "es") == ""


def test_hint_block_falls_back_to_default_lang():
    # Unknown lang must still produce the (Spanish) internal label, not crash.
    block = persona.build_hint_block("send_photos", None, "de")
    assert "PISTA INTERNA" in block


def test_echoed_hint_label_is_caught_by_leak_detector():
    """If Sara ever echoes the internal-hint label in her reply, the output leak
    detector must catch it (defense-in-depth against second-order echo)."""
    block = persona.build_hint_block("close_booking", "razón", "es")
    assert reply_engine._has_leak(block) is True                       # echoed label → discarded
    assert reply_engine._has_leak("hola guapo 😘 ¿te reservo?") is False  # clean reply passes


# ── generate_reply injection (mocked DB + Claude call) ────────────────
class _FakePool:
    """Stand-in asyncpg pool — never used directly because the queries layer
    is monkeypatched; present only to satisfy the signature."""


def _patch_common(monkeypatch, hint):
    """Patch the knowledge loader, recent turns and the analysis-hint query so
    generate_reply runs without a DB. Returns the captured-system recorder."""
    knowledge = CasaKnowledge(_profile(), [_girl()])

    async def fake_knowledge(kpi, casa_id):
        return knowledge

    async def fake_turns(kpi, conv_id, limit=8):
        return []  # no prior turns; the incoming message becomes the only turn

    async def fake_hint(kpi, conv_id):
        if isinstance(hint, Exception):
            raise hint
        return hint

    captured: dict[str, str] = {}

    async def fake_call_text(system, user, *, history=None, **kw):
        captured["system"] = system
        captured["user"] = user
        return "heyyy guapo 😘 ¿te la reservo?"

    monkeypatch.setattr(reply_engine.queries, "get_casa_knowledge", fake_knowledge)
    monkeypatch.setattr(reply_engine.queries, "get_recent_turns", fake_turns)
    monkeypatch.setattr(reply_engine.queries, "get_latest_analysis_hint", fake_hint)
    monkeypatch.setattr(reply_engine, "_call_text", fake_call_text)
    return captured


async def test_present_hint_is_injected_into_system_prompt(monkeypatch):
    hint = AnalysisHint(
        action="close_booking", why="cliente ya pidió hora y chica",
    )
    captured = _patch_common(monkeypatch, hint)
    reply = await generate_reply(
        _FakePool(), casa_id=1, conv_id=42, incoming_text="quiero reservar",
        lang="es", client_name="Juan",
    )
    assert reply == "heyyy guapo 😘 ¿te la reservo?"
    system = captured["system"]
    # Injected into the trusted system block (NOT the user/history turn)...
    assert "PISTA INTERNA" in system
    assert "cerrar la reserva" in system
    assert "PISTA INTERNA" not in captured["user"]   # never on the client edge
    # ...and labelled internal / never-quote / soft.
    assert "NUNCA la menciones" in system
    assert "no estás obligada" in system


async def test_no_hint_keeps_prompt_byte_for_byte_identical(monkeypatch):
    """When the query returns None the system prompt must equal the no-hint
    baseline exactly — proving the feature is opt-in and fail-soft."""
    captured = _patch_common(monkeypatch, None)
    await generate_reply(
        _FakePool(), casa_id=1, conv_id=42, incoming_text="hola",
        lang="es", client_name="Juan",
    )
    baseline = reply_engine.build_system_prompt(
        "es", CasaKnowledge(_profile(), [_girl()]), "Juan"
    )
    assert captured["system"] == baseline
    assert "PISTA INTERNA" not in captured["system"]


async def test_hint_query_exception_does_not_propagate(monkeypatch):
    """A failing hint query must fall through to a normal reply, never raise —
    and the prompt must not contain a half-built hint."""
    captured = _patch_common(monkeypatch, RuntimeError("db down"))
    reply = await generate_reply(
        _FakePool(), casa_id=1, conv_id=42, incoming_text="hola",
        lang="es", client_name="Juan",
    )
    assert reply == "heyyy guapo 😘 ¿te la reservo?"   # normal reply still sent
    assert "PISTA INTERNA" not in captured["system"]   # no partial hint leaked


async def test_non_actionable_hint_does_not_change_prompt(monkeypatch):
    """An 'escalate_human' next_action yields no hint line — prompt unchanged."""
    hint = AnalysisHint(
        action="escalate_human", why="cliente agresivo",
    )
    captured = _patch_common(monkeypatch, hint)
    await generate_reply(
        _FakePool(), casa_id=1, conv_id=42, incoming_text="hola",
        lang="es", client_name="Juan",
    )
    baseline = reply_engine.build_system_prompt(
        "es", CasaKnowledge(_profile(), [_girl()]), "Juan"
    )
    assert captured["system"] == baseline
