"""Tests for the F3 outcall-price injection into Sara's reply.

Two layers, both pure / mocked (no DB / LLM / network), mirroring
test_analyzer_hint.py:
  * persona.build_outcall_block — pure: priced block quotes the EXACT number with
    a never-recompute directive; defer block asks for the pin; falls back to es;
    the echoed label is caught by the leak detector.
  * reply_engine.generate_reply — mocks the knowledge loader, recent turns,
    analysis hint and the Claude call to assert:
      (a) a precomputed total lands in the SYSTEM block (verbatim) not the user
          turn;
      (b) the defer flag injects the defer block;
      (c) with no outcall context the system prompt is byte-for-byte the no-hint
          baseline (the feature is opt-in / fail-soft).
"""
from __future__ import annotations

from app.agent import persona, reply_engine
from app.agent.reply_engine import generate_reply
from app.queries import CasaKnowledge, CasaProfileRow, GirlRow


# ── Fixtures (same **over override pattern as test_agent.py) ──────────
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


# ── persona.build_outcall_block (pure) ────────────────────────────────
def test_outcall_block_quotes_base_and_taxi_range():
    block = persona.build_outcall_block(150, 60, 110, "es")
    assert "PRECIO DE DESPLAZAMIENTO" in block
    assert "150€" in block                          # the domicilio base
    assert "60€" in block and "110€" in block       # the taxi RANGE (low-high)
    assert "domicilio" in block
    assert "rondar" in block                         # given as a range…
    assert "NUNCA una cifra exacta" in block         # …never an exact figure
    assert "NUNCA menciones" in block                # internal / never-quote


def test_outcall_block_defer_asks_for_pin_and_invents_nothing():
    block = persona.build_outcall_block(None, None, None, "es")
    assert "DESPLAZAMIENTO SIN PRECIO" in block
    assert "NO inventes" in block
    assert "📍" in block                     # ask for the location pin
    # The defer block must NOT contain a euro figure.
    assert "€" not in block


def test_outcall_block_falls_back_to_default_lang():
    block = persona.build_outcall_block(120, 40, 90, "de")  # unknown lang → es
    assert "PRECIO DE DESPLAZAMIENTO" in block
    assert "120€" in block and "40€" in block and "90€" in block


def test_outcall_block_localized_en():
    block = persona.build_outcall_block(160, 50, 100, "en")
    assert "OUTCALL PRICE" in block
    assert "160€" in block and "50€" in block and "100€" in block
    assert "NEVER an exact figure" in block


def test_echoed_outcall_label_is_caught_by_leak_detector():
    """If Sara echoes the internal outcall label, the leak detector discards it."""
    assert reply_engine._has_leak(persona.build_outcall_block(150, 60, 110, "es")) is True
    assert reply_engine._has_leak(persona.build_outcall_block(None, None, None, "es")) is True
    assert reply_engine._has_leak(persona.build_outcall_block(160, 50, 100, "en")) is True
    # A clean priced reply (just the numbers, no label) passes.
    assert reply_engine._has_leak("son 150€ + el taxi, guapo 😘") is False


# ── generate_reply injection (mocked DB + Claude call) ────────────────
class _FakePool:
    """Stand-in asyncpg pool — never used directly (queries are monkeypatched)."""


def _patch_common(monkeypatch):
    knowledge = CasaKnowledge(_profile(), [_girl()])

    async def fake_knowledge(kpi, casa_id):
        return knowledge

    async def fake_turns(kpi, conv_id, limit=8):
        return []

    async def fake_hint(kpi, conv_id):
        return None

    captured: dict[str, str] = {}

    async def fake_call_text(system, user, *, history=None, **kw):
        captured["system"] = system
        captured["user"] = user
        return "claro guapo 😘 son 170€"

    monkeypatch.setattr(reply_engine.queries, "get_casa_knowledge", fake_knowledge)
    monkeypatch.setattr(reply_engine.queries, "get_recent_turns", fake_turns)
    monkeypatch.setattr(reply_engine.queries, "get_latest_analysis_hint", fake_hint)
    monkeypatch.setattr(reply_engine, "_call_text", fake_call_text)
    return captured


async def test_precomputed_total_injected_into_system_not_user(monkeypatch):
    captured = _patch_common(monkeypatch)
    await generate_reply(
        _FakePool(), casa_id=1, conv_id=42, incoming_text="cuanto el desplazamiento",
        lang="es", client_name="Juan", outcall_base_eur=150,
        outcall_taxi_low=60, outcall_taxi_high=110,
    )
    system = captured["system"]
    assert "PRECIO DE DESPLAZAMIENTO" in system
    # base + taxi range injected verbatim in the system block
    assert "150€" in system and "60€" in system and "110€" in system
    assert "PRECIO DE DESPLAZAMIENTO" not in captured["user"]  # never on the client edge
    assert "150€" not in captured["user"]


async def test_defer_flag_injects_defer_block(monkeypatch):
    captured = _patch_common(monkeypatch)
    await generate_reply(
        _FakePool(), casa_id=1, conv_id=42, incoming_text="quiero que venga a mi hotel",
        lang="es", client_name="Juan", outcall_defer=True,
    )
    system = captured["system"]
    assert "DESPLAZAMIENTO SIN PRECIO" in system
    assert "📍" in system


async def test_no_outcall_context_keeps_prompt_byte_for_byte(monkeypatch):
    """No outcall context → system prompt equals the no-hint baseline exactly."""
    captured = _patch_common(monkeypatch)
    await generate_reply(
        _FakePool(), casa_id=1, conv_id=42, incoming_text="hola",
        lang="es", client_name="Juan",
    )
    baseline = reply_engine.build_system_prompt(
        "es", CasaKnowledge(_profile(), [_girl()]), "Juan"
    )
    assert captured["system"] == baseline
    # The DYNAMIC internal blocks must be absent (the static persona rule that
    # mentions "DESPLAZAMIENTO" is part of the baseline and is expected).
    assert "PRECIO DE DESPLAZAMIENTO" not in captured["system"]
    assert "DESPLAZAMIENTO SIN PRECIO" not in captured["system"]


async def test_total_takes_precedence_over_defer(monkeypatch):
    """If both are passed, the concrete price wins (priced block, not defer)."""
    captured = _patch_common(monkeypatch)
    await generate_reply(
        _FakePool(), casa_id=1, conv_id=42, incoming_text="precio",
        lang="es", client_name="Juan",
        outcall_base_eur=180, outcall_taxi_low=70, outcall_taxi_high=130,
        outcall_defer=True,
    )
    assert "PRECIO DE DESPLAZAMIENTO" in captured["system"]
    assert "180€" in captured["system"]
    assert "70€" in captured["system"] and "130€" in captured["system"]
    assert "DESPLAZAMIENTO SIN PRECIO" not in captured["system"]
