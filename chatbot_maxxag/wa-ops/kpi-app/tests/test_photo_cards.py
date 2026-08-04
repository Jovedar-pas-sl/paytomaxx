"""Unit tests for the F2 girl-photo-card feature.

Two layers, both pure / fully mocked (no DB, LLM or network):

  1. `photo_select` — the deterministic selection helper:
     named-in-reply match (incl. accents), photo-intent fallback, the hard cap
     of 2, skipping no-photo girls, de-dup, and caption building.
  2. The `auto_reply_job` PHOTO WIRING — a fake WahaClient recording send_image
     calls + a fake redis: <= 2 images sent, each paced + recorded, fail-soft
     when send_image raises, and copilot sends NO photos.

Mirrors the mocking style of test_auto_reply.py.
"""
from __future__ import annotations

import types
from dataclasses import dataclass, replace

import pytest

from app.agent import auto_reply, photo_select
from app.agent.auto_reply import auto_reply_job
from app.agent.photo_select import (
    _MAX_PHOTOS,
    build_caption,
    select_photo_girls,
)
from app.queries import GirlRow


# ── Girl factory ─────────────────────────────────────────────────────
def _girl(
    gid: int,
    name: str,
    *,
    age: int | None = 25,
    nationality: str | None = "española",
    photo_url: str | None = "https://cdn/x.jpg",
    available_today: bool = True,
    services: list[str] | None = None,
) -> GirlRow:
    return GirlRow(
        id=gid,
        casa_id=7,
        ext_id=None,
        name=name,
        age=age,
        nationality=nationality,
        description="desc",
        photo_url=photo_url,
        whatsapp=None,
        available_today=available_today,
        outcall=False,
        escort_pareja=False,
        services=services or [],
        languages=[],
    )


# ── photo_select.select_photo_girls — named in reply ─────────────────
def test_named_in_reply_is_selected_in_reply_order():
    girls = [_girl(1, "Sofía"), _girl(2, "Lucía"), _girl(3, "Marta")]
    # Reply names Lucía BEFORE Sofía → result must follow reply order.
    reply = "Te recomiendo a Lucía, y también está Sofía disponible hoy."
    out = select_photo_girls(girls, reply, incoming_text="hola")
    assert [g.id for g in out] == [2, 1]


def test_named_match_is_accent_insensitive():
    girls = [_girl(1, "Mariña"), _girl(2, "José")]
    # Reply writes the names WITHOUT accents — must still match.
    reply = "Marina y Jose te esperan."
    out = select_photo_girls(girls, reply, incoming_text="")
    assert {g.id for g in out} == {1, 2}


def test_named_match_is_case_insensitive():
    girls = [_girl(1, "Valentina")]
    out = select_photo_girls(girls, "VALENTINA es genial", incoming_text="")
    assert [g.id for g in out] == [1]


def test_unnamed_girls_without_intent_are_not_sent():
    girls = [_girl(1, "Sofía"), _girl(2, "Lucía")]
    # Reply names nobody, incoming has no photo intent → send nothing.
    out = select_photo_girls(girls, "Hola, dime en qué te ayudo.", incoming_text="precio?")
    assert out == []


# ── photo_select.select_photo_girls — photo-intent fallback ──────────
@pytest.mark.parametrize(
    "incoming",
    ["mándame fotos", "tienes pics?", "enséñame una imagen", "quiero ver", "manda foto"],
)
def test_photo_intent_fallback_sends_first_candidates(incoming):
    girls = [_girl(1, "A"), _girl(2, "B"), _girl(3, "C")]
    # Reply names nobody, but the client asked for photos → first candidates.
    out = select_photo_girls(girls, "Claro, un momento.", incoming_text=incoming)
    assert [g.id for g in out] == [1, 2]  # capped at 2, in sort order


def test_named_takes_priority_over_intent_fallback():
    girls = [_girl(1, "A"), _girl(2, "Lucía")]
    # Both a photo intent AND a named girl: the NAMED girl wins, fallback ignored.
    out = select_photo_girls(girls, "Lucía está disponible", incoming_text="mándame fotos")
    assert [g.id for g in out] == [2]


def test_no_intent_keyword_substring_false_positive():
    girls = [_girl(1, "A")]
    # "verde" contains "ver" but must NOT trigger the fallback (whole-word match).
    out = select_photo_girls(girls, "Claro.", incoming_text="el sofá es verde")
    assert out == []


# ── photo_select.select_photo_girls — cap / skip / de-dup ────────────
def test_hard_cap_at_two_even_with_more_named():
    girls = [_girl(1, "Ana"), _girl(2, "Bea"), _girl(3, "Cris"), _girl(4, "Dani")]
    out = select_photo_girls(girls, "Ana Bea Cris Dani todas hoy", incoming_text="")
    assert len(out) == _MAX_PHOTOS == 2


def test_girls_without_photo_are_skipped():
    girls = [_girl(1, "Ana", photo_url=None), _girl(2, "Bea", photo_url="  "), _girl(3, "Cris")]
    # Ana (None) and Bea (blank) are not candidates even though named.
    out = select_photo_girls(girls, "Ana Bea Cris disponibles", incoming_text="")
    assert [g.id for g in out] == [3]


def test_unavailable_girls_are_skipped():
    girls = [_girl(1, "Ana", available_today=False), _girl(2, "Bea")]
    out = select_photo_girls(girls, "Ana Bea aquí", incoming_text="")
    assert [g.id for g in out] == [2]


def test_single_letter_name_is_not_matched():
    """A 1-char name is too short for a safe substring match — never selected by
    name (avoids spurious hits inside ordinary words)."""
    out = select_photo_girls([_girl(1, "A")], "hay A disponible", incoming_text="")
    assert out == []


def test_empty_candidates_returns_empty():
    assert select_photo_girls([], "Lucía", incoming_text="fotos") == []


def test_dedup_preserves_first_occurrence():
    g = _girl(1, "Lucía")
    # Same girl id twice in the input list must yield one card.
    out = select_photo_girls([g, replace(g)], "Lucía Lucía", incoming_text="")
    assert [x.id for x in out] == [1]


# ── photo_select.build_caption ───────────────────────────────────────
def test_caption_full():
    cap = build_caption(_girl(1, "Sofía", age=23, nationality="rusa", services=["a", "b", "c"]))
    # name, age · nationality, then up to 2 services on a second line.
    assert cap.startswith("Sofía, 23 · rusa")
    assert "a, b" in cap and "c" not in cap.split("\n")[-1]


def test_caption_omits_missing_fields():
    cap = build_caption(_girl(1, "Ana", age=None, nationality=None, services=[]))
    assert cap == "Ana"


# ════════════════════════════════════════════════════════════════════
# Job-flow wiring tests (mirrors test_auto_reply.py mocking)
# ════════════════════════════════════════════════════════════════════
@dataclass
class _Detail:
    casa_id: int = 7
    casa_name: str = "Maxxage Valencia"
    waha_session: str = "vlc"
    contact_jid: str = "34600000001@c.us"
    contact_name: str | None = "Juan"


@dataclass
class _Escalation:
    should_escalate: bool
    severity: str


class _FakeWaha:
    """Records send_text + send_image calls; send_image can be made to raise."""

    def __init__(self, *, fail_image: bool = False) -> None:
        self.sent_text: list[tuple[str, str, str]] = []
        self.sent_images: list[tuple[str, str, str, str]] = []
        self.marked_read = 0
        self.typing = 0
        self._fail_image = fail_image

    async def mark_read(self, session: str, chat: str) -> None:
        self.marked_read += 1

    async def start_typing(self, session: str, chat: str) -> None:
        self.typing += 1

    async def send_text(self, session: str, chat: str, text: str) -> dict:
        self.sent_text.append((session, chat, text))
        return {"id": "waha-text-1"}

    async def send_image(self, session: str, chat: str, url: str, caption: str) -> dict:
        if self._fail_image:
            raise RuntimeError("waha image boom")
        self.sent_images.append((session, chat, url, caption))
        return {"id": f"waha-img-{len(self.sent_images)}"}


# Fake asyncpg-like pool (the photo persist uses kpi.acquire()).
class _FakeConn:
    def __init__(self) -> None:
        self.execs: list[str] = []

    async def execute(self, sql, *args):
        self.execs.append(sql)


class _FakeAcquire:
    def __init__(self, conn):
        self._conn = conn

    async def __aenter__(self):
        return self._conn

    async def __aexit__(self, *exc):
        return False


class _FakePool:
    def __init__(self) -> None:
        self.conn = _FakeConn()

    def acquire(self):
        return _FakeAcquire(self.conn)


@pytest.fixture
def patched(monkeypatch):
    """Patch the queries layer + skills + reply engine + rate_limit + photo
    roster so auto_reply_job runs without DB/LLM/network. Returns a recorder."""
    rec = types.SimpleNamespace(
        statuses=[], alerts=[], reply="Te recomiendo a Lucía y a Sofía 😘",
        mode="auto", agent_status=None, flags=None, escalation=None,
        recent_human=False, detail=_Detail(),
        generated=False, quiet=False, allow=(True, ""), paced=[], recorded=[],
        # photo roster the job will see + intent of the last incoming message
        girls=[], incoming="hola",
    )

    async def fake_get_mode(kpi, conv_id):
        return rec.mode

    async def fake_get_status(kpi, conv_id):
        return rec.agent_status

    async def fake_set_status(kpi, conv_id, status):
        rec.statuses.append(status)

    async def fake_has_recent(kpi, conv_id, within):
        return rec.recent_human

    async def fake_last_agent(kpi, conv_id):
        return False  # not-yet-replied so the job proceeds to the photo path

    async def fake_detail(kpi, conv_id):
        return rec.detail

    async def fake_insert_alert(kpi, **kw):
        rec.alerts.append(kw)

    async def fake_red_flags(msgs):
        if isinstance(rec.flags, Exception):
            raise rec.flags
        return rec.flags or []

    async def fake_escalation(msgs):
        return rec.escalation or _Escalation(False, "none")

    async def fake_generate_reply(kpi, **kw):
        rec.generated = True
        return rec.reply

    async def fake_load_msgs(kpi, conv_id):
        from app.analyzer.skills import Message
        return [Message(ts=1, role="cliente", content=rec.incoming)]

    async def fake_girls_with_photo(kpi, casa_id):
        return rec.girls

    async def fast_sleep(_):
        return None

    def fake_quiet(now_local=None):
        return rec.quiet

    async def fake_allow(redis, session):
        return rec.allow

    async def fake_pace(redis, session):
        rec.paced.append(session)

    async def fake_record(redis, session):
        rec.recorded.append(session)

    monkeypatch.setattr(auto_reply.queries, "get_wa_mode_for_conversation", fake_get_mode)
    monkeypatch.setattr(auto_reply.queries, "get_conversation_agent_status", fake_get_status)
    monkeypatch.setattr(auto_reply.queries, "set_conversation_agent_status", fake_set_status)
    monkeypatch.setattr(auto_reply.queries, "has_recent_human_outbound", fake_has_recent)
    monkeypatch.setattr(auto_reply.queries, "last_out_is_agent_generated", fake_last_agent)
    monkeypatch.setattr(auto_reply.queries, "get_conversation_detail", fake_detail)
    # Photo cards are OFF in production (_PHOTO_CARDS_ENABLED=False); these wiring
    # tests exercise the PRESERVED photo path, so re-enable it for the fixture.
    monkeypatch.setattr(auto_reply, "_PHOTO_CARDS_ENABLED", True)
    monkeypatch.setattr(auto_reply.queries, "insert_alert", fake_insert_alert)
    monkeypatch.setattr(auto_reply.queries, "get_available_girls_with_photo", fake_girls_with_photo)
    monkeypatch.setattr(auto_reply.skills, "detect_red_flags", fake_red_flags)
    monkeypatch.setattr(auto_reply.skills, "evaluate_escalation", fake_escalation)
    monkeypatch.setattr(auto_reply.reply_engine, "generate_reply", fake_generate_reply)
    monkeypatch.setattr(auto_reply, "_load_msgs", fake_load_msgs)
    monkeypatch.setattr(auto_reply.rate_limit, "in_quiet_hours", fake_quiet)
    monkeypatch.setattr(auto_reply.rate_limit, "allow_send", fake_allow)
    monkeypatch.setattr(auto_reply.rate_limit, "pace", fake_pace)
    monkeypatch.setattr(auto_reply.rate_limit, "record_send", fake_record)
    monkeypatch.setattr(auto_reply.asyncio, "sleep", fast_sleep)
    return rec


def _ctx_rl(waha, pool):
    """Job ctx WITH a redis handle so the anti-ban photo path is exercised."""
    return {"kpi_db": pool, "waha": waha, "redis": object()}


async def test_photos_sent_for_named_girls_after_text(patched):
    patched.girls = [_girl(1, "Lucía"), _girl(2, "Sofía"), _girl(3, "Marta")]
    waha = _FakeWaha()
    await auto_reply_job(_ctx_rl(waha, _FakePool()), 1)
    # text first, then exactly the two NAMED girls' photos.
    assert len(waha.sent_text) == 1
    sent_urls = [u for (_s, _c, u, _cap) in waha.sent_images]
    assert sent_urls == [_girl(1, "x").photo_url, _girl(2, "x").photo_url]
    assert {cap.split(",")[0] for (_s, _c, _u, cap) in waha.sent_images} == {"Lucía", "Sofía"}


async def test_photo_hard_cap_two_even_if_more_named(patched):
    patched.reply = "Lucía, Sofía, Marta y Ana, todas disponibles"
    patched.girls = [_girl(1, "Lucía"), _girl(2, "Sofía"), _girl(3, "Marta"), _girl(4, "Ana")]
    waha = _FakeWaha()
    await auto_reply_job(_ctx_rl(waha, _FakePool()), 1)
    assert len(waha.sent_images) == 2  # hard cap


async def test_each_photo_is_paced_and_recorded(patched):
    patched.girls = [_girl(1, "Lucía"), _girl(2, "Sofía")]
    waha = _FakeWaha()
    await auto_reply_job(_ctx_rl(waha, _FakePool()), 1)
    # 1 text + 2 photos. The text path paces once + records once; each photo
    # paces once + records once → 3 paces, 3 records, all on the same session.
    assert patched.paced == ["vlc", "vlc", "vlc"]
    assert patched.recorded == ["vlc", "vlc", "vlc"]


async def test_photo_send_failure_is_fail_soft(patched):
    patched.girls = [_girl(1, "Lucía"), _girl(2, "Sofía")]
    waha = _FakeWaha(fail_image=True)
    # Must NOT raise even though every send_image raises.
    await auto_reply_job(_ctx_rl(waha, _FakePool()), 1)
    assert len(waha.sent_text) == 1   # text reply still went out
    assert waha.sent_images == []     # both images failed, swallowed
    # text was recorded (1) but neither failed photo was counted.
    assert patched.recorded == ["vlc"]


async def test_photo_rate_limit_stops_burst(patched, monkeypatch):
    """If the per-number cap blocks before a photo, the photo burst stops."""
    patched.girls = [_girl(1, "Lucía"), _girl(2, "Sofía")]
    waha = _FakeWaha()

    calls = {"n": 0}

    async def allow_then_block(redis, session):
        # text-gate allows; the FIRST photo gate blocks.
        calls["n"] += 1
        return (True, "") if calls["n"] == 1 else (False, "min-cap")

    monkeypatch.setattr(auto_reply.rate_limit, "allow_send", allow_then_block)
    await auto_reply_job(_ctx_rl(waha, _FakePool()), 1)
    assert len(waha.sent_text) == 1
    assert waha.sent_images == []  # blocked before any photo went out


async def test_copilot_sends_no_photos(patched):
    patched.mode = "copilot"
    patched.girls = [_girl(1, "Lucía"), _girl(2, "Sofía")]
    waha = _FakeWaha()
    await auto_reply_job(_ctx_rl(waha, _FakePool()), 1)
    assert waha.sent_text == []    # copilot never sends text
    assert waha.sent_images == []  # ...and never sends photos
    assert patched.alerts and patched.alerts[0]["type"] == "agent_suggestion"


async def test_photo_intent_fallback_sends_when_no_girl_named(patched):
    patched.reply = "Claro guapo, un momento."  # names nobody
    patched.incoming = "mándame fotos porfa"
    patched.girls = [_girl(1, "Lucía"), _girl(2, "Sofía"), _girl(3, "Marta")]
    waha = _FakeWaha()
    await auto_reply_job(_ctx_rl(waha, _FakePool()), 1)
    assert len(waha.sent_images) == 2  # first two candidates

async def test_no_photos_when_roster_empty(patched):
    patched.girls = []
    waha = _FakeWaha()
    await auto_reply_job(_ctx_rl(waha, _FakePool()), 1)
    assert len(waha.sent_text) == 1
    assert waha.sent_images == []
