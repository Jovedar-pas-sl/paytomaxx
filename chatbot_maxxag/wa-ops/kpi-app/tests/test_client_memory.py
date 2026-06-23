"""Tests for per-client memory (F3).

Four layers, the first three pure / fully mocked (no DB, LLM or network):
  * `persona.build_memory_block` — pure: silent never-quote phrasing, per-clause
    omission, lang fallback, empty -> "", and that its LABEL is caught by
    `reply_engine._has_leak` while a girl NAME alone is NOT.
  * `photo_select.match_named_girls` — the reused client-name matcher: returns
    the girls the client named, accent/case-insensitively, short-name guard.
  * `reply_engine.generate_reply` — mocks the queries layer + `_call_text` to
    assert the read injects into `system` (not the user turn), the no-memory
    baseline is byte-for-byte identical, read/write exceptions don't propagate,
    and the upsert is called with the resolved lang + the girl(s) named.
  * DB-bound round-trip + 90-day freshness — auto-skips without TEST_DATABASE_URL
    (pg_pool fixture pattern).
"""
from __future__ import annotations

import pytest

from app import queries
from app.agent import persona, photo_select, reply_engine
from app.agent.reply_engine import generate_reply
from app.queries import CasaKnowledge, CasaProfileRow, ClientMemory, GirlRow


# ── Fixtures (mirror test_analyzer_hint.py / test_agent.py) ───────────
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


# ═══════════════════════════════════════════════════════════════════
# persona.build_memory_block (pure)
# ═══════════════════════════════════════════════════════════════════
def test_memory_block_silent_never_quote_phrasing():
    block = persona.build_memory_block("es", "inglés", ["Lucía"])
    assert "MEMORIA DEL CLIENTE" in block
    assert "NUNCA digas que recuerdas" in block          # silent / never-quote
    assert "suele escribir en inglés" in block
    assert "le interesaron Lucía" in block
    assert "Retómalas solo si encaja" in block           # soft re-offer


def test_memory_block_omits_empty_lang_clause():
    block = persona.build_memory_block("es", None, ["Lucía"])
    assert "le interesaron Lucía" in block
    assert "suele escribir" not in block                 # no lang → clause omitted


def test_memory_block_omits_empty_girls_clause():
    block = persona.build_memory_block("es", "francés", [])
    assert "suele escribir en francés" in block
    assert "interesaron" not in block                    # no girls → clause omitted


def test_memory_block_empty_when_nothing_to_say():
    assert persona.build_memory_block("es", None, []) == ""
    assert persona.build_memory_block("es", "", None) == ""
    assert persona.build_memory_block("es", "  ", ["  "]) == ""  # whitespace-only


def test_memory_block_falls_back_to_default_lang():
    # Unknown lang must still produce the (Spanish) label, not crash.
    block = persona.build_memory_block("de", "alemán", ["Marta"])
    assert "MEMORIA DEL CLIENTE" in block


@pytest.mark.parametrize("lang", ["en", "fr", "it"])
def test_memory_block_localized_labels(lang):
    block = persona.build_memory_block(lang, "x", ["Marta"])
    expected = persona._MEMORY_LABELS[lang]
    assert expected in block


def test_memory_block_caps_rendered_girl_names():
    names = [f"G{i}" for i in range(10)]
    block = persona.build_memory_block("es", None, names)
    # Only the first _MEMORY_MAX_NAMES are rendered.
    assert "G0" in block and f"G{persona._MEMORY_MAX_NAMES - 1}" in block
    assert f"G{persona._MEMORY_MAX_NAMES}" not in block


def test_memory_label_is_caught_by_leak_detector_but_name_is_not():
    """An echoed memory LABEL must be discarded by the output leak detector, but a
    bare girl NAME must NOT be a marker (re-offering by name is the whole point)."""
    block = persona.build_memory_block("es", "inglés", ["Lucía"])
    assert reply_engine._has_leak(block) is True             # echoed label → discarded
    assert reply_engine._has_leak("¿te reservo a Lucía? 😘") is False  # name alone passes


@pytest.mark.parametrize("lang", ["es", "en", "fr", "it"])
def test_every_memory_label_is_a_leak_marker(lang):
    block = persona.build_memory_block(lang, "x", ["Marta"])
    assert reply_engine._has_leak(block) is True


# ═══════════════════════════════════════════════════════════════════
# photo_select.match_named_girls (reused matcher)
# ═══════════════════════════════════════════════════════════════════
def test_match_named_girls_returns_named_in_text_order():
    girls = [_girl(id=1, name="Sofía"), _girl(id=2, name="Lucía"), _girl(id=3, name="Marta")]
    out = photo_select.match_named_girls("me gustó Lucía y también Sofía", girls)
    assert [g.id for g in out] == [2, 1]                  # text order


def test_match_named_girls_is_accent_and_case_insensitive():
    girls = [_girl(id=1, name="Mariña"), _girl(id=2, name="José")]
    out = photo_select.match_named_girls("quiero a MARINA y a jose", girls)
    assert {g.id for g in out} == {1, 2}


def test_match_named_girls_skips_short_names_and_empty_text():
    assert photo_select.match_named_girls("hay A por aquí", [_girl(id=1, name="A")]) == []
    assert photo_select.match_named_girls("", [_girl(id=1, name="Lucía")]) == []


# ═══════════════════════════════════════════════════════════════════
# generate_reply read+write wiring (mocked DB + Claude call)
# ═══════════════════════════════════════════════════════════════════
class _FakePool:
    """Stand-in asyncpg pool — never used directly (queries are monkeypatched)."""


def _patch_common(monkeypatch, *, memory, girls=None):
    """Patch knowledge/turns/hint/memory queries + _call_text so generate_reply
    runs without a DB. Returns (captured, upserts): captured records the
    system/user passed to Claude; upserts records every upsert_client_memory call.
    """
    knowledge = CasaKnowledge(_profile(), girls if girls is not None else [_girl(name="Lucía")])

    async def fake_knowledge(kpi, casa_id):
        return knowledge

    async def fake_turns(kpi, conv_id, limit=8):
        return []

    async def fake_hint(kpi, conv_id):
        return None  # no analyzer hint — isolate the memory feature

    async def fake_get_memory(kpi, conv_id):
        if isinstance(memory, Exception):
            raise memory
        return memory

    upserts: list[dict] = []

    async def fake_upsert(kpi, conv_id, preferred_lang, preferred_girls):
        upserts.append(
            dict(conv_id=conv_id, lang=preferred_lang, girls=list(preferred_girls))
        )

    captured: dict[str, str] = {}

    async def fake_call_text(system, user, *, history=None, **kw):
        captured["system"] = system
        captured["user"] = user
        return "heyyy guapo 😘 ¿te la reservo?"

    monkeypatch.setattr(reply_engine.queries, "get_casa_knowledge", fake_knowledge)
    monkeypatch.setattr(reply_engine.queries, "get_recent_turns", fake_turns)
    monkeypatch.setattr(reply_engine.queries, "get_latest_analysis_hint", fake_hint)
    monkeypatch.setattr(reply_engine.queries, "get_client_memory", fake_get_memory)
    monkeypatch.setattr(reply_engine.queries, "upsert_client_memory", fake_upsert)
    monkeypatch.setattr(reply_engine, "_call_text", fake_call_text)
    return captured, upserts


async def test_present_memory_injected_into_system_not_user(monkeypatch):
    memory = ClientMemory(preferred_lang="inglés", preferred_girls=["Lucía"])
    captured, _ = _patch_common(monkeypatch, memory=memory)
    reply = await generate_reply(
        _FakePool(), casa_id=1, conv_id=42, incoming_text="hola",
        lang="es", client_name="Juan",
    )
    assert reply == "heyyy guapo 😘 ¿te la reservo?"
    system = captured["system"]
    assert "MEMORIA DEL CLIENTE" in system               # injected into trusted block
    assert "le interesaron Lucía" in system
    assert "MEMORIA DEL CLIENTE" not in captured["user"]  # never on the client edge


async def test_no_memory_keeps_prompt_byte_for_byte_identical(monkeypatch):
    """No memory row → the system prompt equals the no-memory baseline exactly."""
    captured, _upserts = _patch_common(monkeypatch, memory=None, girls=[_girl(name="Lucía")])
    await generate_reply(
        _FakePool(), casa_id=1, conv_id=42, incoming_text="hola",  # names no girl
        lang="es", client_name="Juan",
    )
    baseline = reply_engine.build_system_prompt(
        "es", CasaKnowledge(_profile(), [_girl(name="Lucía")]), "Juan"
    )
    assert captured["system"] == baseline
    assert "MEMORIA DEL CLIENTE" not in captured["system"]


async def test_memory_read_exception_does_not_propagate(monkeypatch):
    """A failing memory READ must fall through to a normal reply, never raise, and
    leave no partial block in the prompt."""
    captured, _ = _patch_common(monkeypatch, memory=RuntimeError("db down"))
    reply = await generate_reply(
        _FakePool(), casa_id=1, conv_id=42, incoming_text="hola",
        lang="es", client_name="Juan",
    )
    assert reply == "heyyy guapo 😘 ¿te la reservo?"
    assert "MEMORIA DEL CLIENTE" not in captured["system"]


async def test_memory_write_exception_does_not_propagate(monkeypatch):
    """A failing memory WRITE must never break the already-good reply."""
    _patch_common(monkeypatch, memory=None, girls=[_girl(name="Lucía")])

    async def boom(kpi, conv_id, preferred_lang, preferred_girls):
        raise RuntimeError("write failed")

    monkeypatch.setattr(reply_engine.queries, "upsert_client_memory", boom)
    reply = await generate_reply(
        _FakePool(), casa_id=1, conv_id=42, incoming_text="quiero a Lucía",
        lang="es", client_name="Juan",
    )
    assert reply == "heyyy guapo 😘 ¿te la reservo?"      # reply still returned


async def test_upsert_called_with_resolved_lang_and_named_girl(monkeypatch):
    """The write records the resolved reply language + the girl(s) the CLIENT
    named in the incoming text."""
    _, upserts = _patch_common(monkeypatch, memory=None, girls=[_girl(name="Lucía")])
    await generate_reply(
        _FakePool(), casa_id=1, conv_id=42, incoming_text="me interesa Lucía",
        lang="es", client_name="Juan",
    )
    assert len(upserts) == 1
    assert upserts[0]["conv_id"] == 42
    assert upserts[0]["lang"] == "es"
    assert upserts[0]["girls"] == ["Lucía"]


async def test_upsert_merges_new_girl_ahead_of_prior(monkeypatch):
    """A newly-named girl is merged most-recent-first ahead of the stored ones,
    deduped accent/case-insensitively."""
    memory = ClientMemory(preferred_lang="es", preferred_girls=["Marta", "Lucia"])
    _, upserts = _patch_common(
        monkeypatch, memory=memory,
        girls=[_girl(id=1, name="Lucía"), _girl(id=2, name="Marta")],
    )
    await generate_reply(
        _FakePool(), casa_id=1, conv_id=42, incoming_text="quiero a Lucía",
        lang="es", client_name="Juan",
    )
    # "Lucía" named now → moves to front; the prior "Lucia" dupe is dropped.
    assert upserts[0]["girls"] == ["Lucía", "Marta"]


async def test_no_upsert_when_nothing_to_store(monkeypatch):
    """With no resolved lang source AND no named girl AND no prior row, no empty
    row is created. We force resolved_lang to '' by giving a profile with no
    default_lang and lang=None."""
    knowledge = CasaKnowledge(
        _profile(default_lang=""), [_girl(name="Lucía")]
    )

    async def fake_knowledge(kpi, casa_id):
        return knowledge

    async def fake_turns(kpi, conv_id, limit=8):
        return []

    async def fake_hint(kpi, conv_id):
        return None

    async def fake_get_memory(kpi, conv_id):
        return None

    upserts: list[dict] = []

    async def fake_upsert(kpi, conv_id, preferred_lang, preferred_girls):
        upserts.append(dict(conv_id=conv_id))

    async def fake_call_text(system, user, *, history=None, **kw):
        return "ok"

    monkeypatch.setattr(reply_engine.queries, "get_casa_knowledge", fake_knowledge)
    monkeypatch.setattr(reply_engine.queries, "get_recent_turns", fake_turns)
    monkeypatch.setattr(reply_engine.queries, "get_latest_analysis_hint", fake_hint)
    monkeypatch.setattr(reply_engine.queries, "get_client_memory", fake_get_memory)
    monkeypatch.setattr(reply_engine.queries, "upsert_client_memory", fake_upsert)
    monkeypatch.setattr(reply_engine, "_call_text", fake_call_text)

    # resolved_lang falls back to DEFAULT_LANG ("es") because default_lang is "" →
    # there IS a resolved lang, so a row WOULD be stored. To prove the "nothing to
    # store" guard we call the helper directly with an empty lang + no girls.
    await reply_engine._remember_client(_FakePool(), 42, "", "hola", [])
    assert upserts == []


# ═══════════════════════════════════════════════════════════════════
# DB-bound round-trip + 90-day freshness (skips without TEST_DATABASE_URL)
# ═══════════════════════════════════════════════════════════════════
async def _seed_conv(pool) -> int:
    """Minimal casa + contact + conversation; also create conversation_memory
    (not in the pg_pool base schema). Returns the conversation id."""
    async with pool.acquire() as conn:
        casa_id = await conn.fetchval(
            "INSERT INTO casa (name, waha_session) VALUES ($1, $2) RETURNING id",
            "Test", "sess",
        )
        contact_id = await conn.fetchval(
            "INSERT INTO contact (waha_jid, name) VALUES ($1, $2) RETURNING id",
            "34600000001@c.us", "Juan",
        )
        conv_id = await conn.fetchval(
            """
            INSERT INTO conversation (casa_id, contact_id, last_message_at)
            VALUES ($1, $2, now()) RETURNING id
            """,
            casa_id, contact_id,
        )
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS conversation_memory (
                conversation_id BIGINT PRIMARY KEY
                    REFERENCES conversation(id) ON DELETE CASCADE,
                preferred_lang TEXT,
                preferred_girls TEXT[],
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
            """
        )
        return conv_id


async def test_db_upsert_then_get_round_trip(pg_pool):
    conv_id = await _seed_conv(pg_pool)
    await queries.upsert_client_memory(pg_pool, conv_id, "en", ["Lucía", "Marta"])

    got = await queries.get_client_memory(pg_pool, conv_id)
    assert got == ClientMemory(preferred_lang="en", preferred_girls=["Lucía", "Marta"])

    # Second upsert overwrites (1:1, ON CONFLICT) and refreshes.
    await queries.upsert_client_memory(pg_pool, conv_id, "fr", ["Sofía"])
    got2 = await queries.get_client_memory(pg_pool, conv_id)
    assert got2 == ClientMemory(preferred_lang="fr", preferred_girls=["Sofía"])


async def test_db_get_returns_none_when_stale(pg_pool):
    """A row whose updated_at is older than 90 days is treated as absent (read-time
    expiry — the freshness predicate lives in get_client_memory)."""
    conv_id = await _seed_conv(pg_pool)
    async with pg_pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO conversation_memory
                (conversation_id, preferred_lang, preferred_girls, updated_at)
            VALUES ($1, $2, $3, now() - interval '91 days')
            """,
            conv_id, "es", ["Lucía"],
        )
    assert await queries.get_client_memory(pg_pool, conv_id) is None


async def test_db_upsert_caps_stored_girls(pg_pool):
    """The writer hard-caps the stored list to bound row growth."""
    conv_id = await _seed_conv(pg_pool)
    names = [f"G{i}" for i in range(10)]
    await queries.upsert_client_memory(pg_pool, conv_id, "es", names)
    got = await queries.get_client_memory(pg_pool, conv_id)
    assert got is not None
    assert got.preferred_girls == names[: queries._MEMORY_MAX_GIRLS]
