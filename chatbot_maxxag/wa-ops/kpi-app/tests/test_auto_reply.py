"""Unit tests for the F2 auto_reply_job guardrail / pause decision logic.

Pure where possible (_should_block, _humanize_typing_seconds). The job-flow
tests mock generate_reply, the guardrail skills, the WahaClient and the queries
layer so no DB / LLM / network is touched — they assert the DECISIONS
(bail / pause_risk / pause_human / send / suggest) and the no-mutation rules.
"""
from __future__ import annotations

import types
from dataclasses import dataclass

import pytest

from app.agent import auto_reply
from app.agent.auto_reply import (
    _MAX_HUMANIZE_DELAY_S,
    _humanize_typing_seconds,
    _should_block,
    auto_reply_job,
)


# ── Lightweight stand-ins for the skill result shapes ────────────────
@dataclass
class _Flag:
    type: str
    reason: str = "x"


@dataclass
class _Escalation:
    should_escalate: bool
    severity: str


@dataclass
class _Detail:
    casa_id: int = 7
    casa_name: str = "Maxxage Valencia"
    waha_session: str = "vlc"
    contact_jid: str = "34600000001@c.us"
    contact_name: str | None = "Juan"


class _FakeWaha:
    """Records the WAHA calls the job makes (send / mark_read / start_typing)."""

    def __init__(self) -> None:
        self.sent: list[tuple[str, str, str]] = []
        self.marked_read = 0
        self.typing = 0

    async def mark_read(self, session: str, chat: str) -> None:
        self.marked_read += 1

    async def start_typing(self, session: str, chat: str) -> None:
        self.typing += 1

    async def send_text(self, session: str, chat: str, text: str) -> dict:
        self.sent.append((session, chat, text))
        return {"id": "waha-msg-1"}


# ── _should_block (pure) ─────────────────────────────────────────────
def test_block_on_minor_red_flag():
    block, reason = _should_block([_Flag("menor")], _Escalation(False, "none"))
    assert block is True
    assert reason == "red_flag"


def test_block_on_fraud_red_flag():
    block, reason = _should_block([_Flag("fraude")], _Escalation(False, "none"))
    assert block is True and reason == "red_flag"


def test_block_on_harassment_red_flag():
    block, _ = _should_block([_Flag("acoso")], _Escalation(False, "none"))
    assert block is True


@pytest.mark.parametrize("flag_type", ["insulto", "timewaster"])
def test_quality_flags_do_not_block(flag_type):
    """insulto / timewaster are quality signals, not safety stops."""
    block, _ = _should_block([_Flag(flag_type)], _Escalation(False, "none"))
    assert block is False


@pytest.mark.parametrize("severity", ["medium", "high"])
def test_block_on_escalation_severity(severity):
    block, reason = _should_block([], _Escalation(True, severity))
    assert block is True
    assert reason == f"escalation:{severity}"


@pytest.mark.parametrize("severity", ["none", "low"])
def test_low_escalation_does_not_block(severity):
    block, _ = _should_block([], _Escalation(True, severity))
    assert block is False


def test_escalation_must_be_should_escalate_true():
    block, _ = _should_block([], _Escalation(False, "high"))
    assert block is False


def test_skill_exceptions_are_fail_open_per_signal():
    """A raised skill never blocks on its own; the other signal still applies."""
    block, _ = _should_block(RuntimeError("boom"), RuntimeError("boom"))
    assert block is False
    # but the surviving signal still fires
    block2, _ = _should_block(RuntimeError("boom"), _Escalation(True, "high"))
    assert block2 is True


def test_empty_results_do_not_block():
    block, _ = _should_block([], _Escalation(False, "none"))
    assert block is False


# ── _humanize_typing_seconds (pure, bounded) ─────────────────────────
def test_typing_seconds_proportional_to_length():
    short = _humanize_typing_seconds(10)
    long = _humanize_typing_seconds(100)
    assert long > short >= 0.0


def test_typing_seconds_is_bounded():
    huge = _humanize_typing_seconds(100_000)
    # Read pause max + typing slice must never exceed the hard cap.
    assert huge <= _MAX_HUMANIZE_DELAY_S


def test_typing_seconds_never_negative():
    assert _humanize_typing_seconds(0) >= 0.0


# ── Job-flow tests (mocked deps) ─────────────────────────────────────
@pytest.fixture
def patched(monkeypatch):
    """Patch the queries layer + skills + reply engine + delay so auto_reply_job
    runs pure. Returns a recorder of agent_status writes + alerts."""
    rec = types.SimpleNamespace(
        statuses=[], alerts=[], superseded=[], reply="claro guapo, te reservo 😘",
        mode="auto", agent_status=None, flags=None, escalation=None,
        recent_human=False, detail=_Detail(),
        # anti-ban control + recorders
        generated=False, quiet=False, allow=(True, ""), paced=[], recorded=[],
        # F3 outcall: latest-incoming coords (None = client sent no pin) and a
        # recorder of the outcall context handed to generate_reply.
        client_location=None, gen_kwargs=None,
    )

    async def fake_get_mode(kpi, conv_id):
        return rec.mode

    async def fake_get_status(kpi, conv_id):
        return rec.agent_status

    async def fake_set_status(kpi, conv_id, status):
        rec.statuses.append(status)

    async def fake_has_recent(kpi, conv_id, within):
        return rec.recent_human

    async def fake_detail(kpi, conv_id):
        return rec.detail

    async def fake_insert_alert(kpi, **kw):
        rec.alerts.append(kw)

    async def fake_supersede(kpi, conv_id):
        rec.superseded.append(conv_id)
        return 0

    async def fake_red_flags(msgs):
        if isinstance(rec.flags, Exception):
            raise rec.flags
        return rec.flags or []

    async def fake_escalation(msgs):
        return rec.escalation or _Escalation(False, "none")

    async def fake_generate_reply(kpi, **kw):
        rec.generated = True
        rec.gen_kwargs = kw
        return rec.reply

    async def fake_latest_location(kpi, conv_id):
        return rec.client_location

    async def fake_load_msgs(kpi, conv_id):
        from app.analyzer.skills import Message
        return [Message(ts=1, role="cliente", content="hola precio?")]

    async def fast_sleep(_):  # no real delay in tests
        return None

    monkeypatch.setattr(auto_reply.queries, "get_wa_mode_for_conversation", fake_get_mode)
    monkeypatch.setattr(auto_reply.queries, "get_conversation_agent_status", fake_get_status)
    monkeypatch.setattr(auto_reply.queries, "set_conversation_agent_status", fake_set_status)
    monkeypatch.setattr(auto_reply.queries, "has_recent_human_outbound", fake_has_recent)
    monkeypatch.setattr(auto_reply.queries, "get_conversation_detail", fake_detail)
    monkeypatch.setattr(auto_reply.queries, "insert_alert", fake_insert_alert)
    monkeypatch.setattr(auto_reply.queries, "supersede_pending_suggestions", fake_supersede)
    monkeypatch.setattr(auto_reply.skills, "detect_red_flags", fake_red_flags)
    monkeypatch.setattr(auto_reply.skills, "evaluate_escalation", fake_escalation)
    monkeypatch.setattr(auto_reply.reply_engine, "generate_reply", fake_generate_reply)
    monkeypatch.setattr(auto_reply.queries, "get_latest_incoming_location", fake_latest_location)
    # Anti-ban limiter — patched so the JOB wiring can be asserted without Redis.
    def fake_quiet(now_local=None):
        return rec.quiet

    async def fake_allow(redis, session):
        return rec.allow

    async def fake_pace(redis, session):
        rec.paced.append(session)

    async def fake_record(redis, session):
        rec.recorded.append(session)

    monkeypatch.setattr(auto_reply, "_load_msgs", fake_load_msgs)
    monkeypatch.setattr(auto_reply.rate_limit, "in_quiet_hours", fake_quiet)
    monkeypatch.setattr(auto_reply.rate_limit, "allow_send", fake_allow)
    monkeypatch.setattr(auto_reply.rate_limit, "pace", fake_pace)
    monkeypatch.setattr(auto_reply.rate_limit, "record_send", fake_record)
    monkeypatch.setattr(auto_reply.asyncio, "sleep", fast_sleep)
    return rec


def _ctx(waha):
    # kpi_db is never touched directly in the auto path (queries are mocked); the
    # send path uses kpi.acquire(), so only the send test supplies a real-ish one.
    return {"kpi_db": object(), "waha": waha}


async def test_mode_off_bails_without_side_effects(patched):
    patched.mode = "off"
    waha = _FakeWaha()
    await auto_reply_job(_ctx(waha), 1)
    assert waha.sent == [] and patched.statuses == [] and patched.alerts == []


async def test_paused_status_bails(patched):
    patched.agent_status = "paused_human"
    waha = _FakeWaha()
    await auto_reply_job(_ctx(waha), 1)
    assert waha.sent == [] and patched.statuses == []


async def test_red_flag_pauses_risk_and_does_not_send(patched):
    patched.flags = [_Flag("menor")]
    waha = _FakeWaha()
    await auto_reply_job(_ctx(waha), 1)
    assert "paused_risk" in patched.statuses
    assert waha.sent == []
    assert patched.alerts and patched.alerts[0]["type"] == "paused_risk"


async def test_recent_human_pauses_human_and_does_not_send(patched):
    patched.recent_human = True
    waha = _FakeWaha()
    await auto_reply_job(_ctx(waha), 1)
    assert patched.statuses == ["paused_human"]
    assert waha.sent == []


async def test_copilot_stores_suggestion_without_sending(patched):
    patched.mode = "copilot"
    waha = _FakeWaha()
    await auto_reply_job(_ctx(waha), 1)
    assert waha.sent == []  # copilot NEVER sends
    assert patched.alerts and patched.alerts[0]["type"] == "agent_suggestion"
    assert patched.alerts[0]["message"] == patched.reply
    # DEDUP: prior unsent drafts are superseded BEFORE the new one is inserted,
    # so at most ONE suggestion stays pending per conversation.
    assert patched.superseded == [1]


async def test_skill_exception_does_not_block_auto_send(patched, monkeypatch):
    """A guardrail skill raising must not stop a clean conversation from sending
    (fail-open per signal); the send path is exercised with a fake kpi pool."""
    patched.flags = RuntimeError("skill down")
    waha = _FakeWaha()
    sent = await _run_send_job(monkeypatch, patched, waha)
    assert sent  # reply still sent despite the red-flag skill error


# ── Send path with a fake asyncpg-like pool ──────────────────────────
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


async def _run_send_job(monkeypatch, rec, waha) -> bool:
    pool = _FakePool()
    ctx = {"kpi_db": pool, "waha": waha}
    await auto_reply_job(ctx, 1)
    return bool(waha.sent)


async def test_auto_mode_sends_and_persists_agent_generated(patched, monkeypatch):
    waha = _FakeWaha()
    sent = await _run_send_job(monkeypatch, patched, waha)
    assert sent
    _session, chat, text = waha.sent[0]
    assert text == patched.reply
    assert chat == patched.detail.contact_jid
    # mark_read + start_typing were both exercised (human-like behaviour).
    assert waha.marked_read == 1 and waha.typing == 1


# ── Anti-ban integration (ctx WITH redis present) ────────────────────
def _ctx_rl(waha, pool):
    """Job ctx WITH a redis handle so the anti-ban path is actually exercised."""
    return {"kpi_db": pool, "waha": waha, "redis": object()}


async def test_quiet_hours_blocks_before_generate(patched):
    """In quiet hours the auto path returns BEFORE the Claude call and sends nothing."""
    patched.quiet = True
    waha = _FakeWaha()
    await auto_reply_job(_ctx_rl(waha, _FakePool()), 1)
    assert waha.sent == []
    assert patched.generated is False   # gated before generate_reply
    assert patched.recorded == []       # nothing recorded


async def test_rate_cap_blocks_before_generate(patched):
    """An at-cap number blocks the auto-send before generation; no record."""
    patched.allow = (False, "min-cap")
    waha = _FakeWaha()
    await auto_reply_job(_ctx_rl(waha, _FakePool()), 1)
    assert waha.sent == []
    assert patched.generated is False
    assert patched.recorded == []


async def test_auto_send_paces_then_records_when_allowed(patched):
    """Allowed: paces BEFORE sending and records the send AFTER, keyed by session."""
    waha = _FakeWaha()
    await auto_reply_job(_ctx_rl(waha, _FakePool()), 1)
    assert waha.sent
    assert patched.paced == [patched.detail.waha_session]
    assert patched.recorded == [patched.detail.waha_session]


# ── F3 OUTCALL integration (mocked) ──────────────────────────────────
def _patch_knowledge(monkeypatch, *, address_lat, address_lng, outcall):
    """Patch get_casa_knowledge so _compute_outcall_context can price/defer."""
    from app.queries import CasaKnowledge, CasaProfileRow

    def _profile() -> CasaProfileRow:
        return CasaProfileRow(
            casa_id=7, casa_name="Maxxage Valencia", bot_name="Sara",
            default_lang="es", whatsapp_recepcion="+34603201414",
            telegram_recepcion="@maxxagvlc", greetings={},
            rates={}, schedule={"hours_es": "24h"}, faqs=[], outcall=outcall,
            address="C. Joaquín Costa 44", address_lat=address_lat,
            address_lng=address_lng, maps_url=None,
        )

    async def fake_knowledge(kpi, casa_id):
        return CasaKnowledge(_profile(), [])

    monkeypatch.setattr(auto_reply.queries, "get_casa_knowledge", fake_knowledge)


async def test_no_location_passes_no_outcall_context(patched):
    """No location PIN → generate_reply gets no outcall context (defer False)."""
    patched.client_location = None
    waha = _FakeWaha()
    await auto_reply_job(_ctx_rl(waha, _FakePool()), 1)
    assert patched.gen_kwargs is not None
    assert patched.gen_kwargs["outcall_base_eur"] is None
    assert patched.gen_kwargs["outcall_taxi_eur"] is None
    assert patched.gen_kwargs["outcall_defer"] is False


async def test_location_with_geo_passes_precomputed_total(patched, monkeypatch):
    """Client PIN + geocoded casa + base price → an exact precomputed total is
    handed to generate_reply (defer False)."""
    patched.client_location = (39.47, -0.37)  # ~near the Valencia casa
    _patch_knowledge(
        monkeypatch, address_lat=39.4699, address_lng=-0.3763,
        outcall={"base_price_eur": 150, "taxi_surcharge_pct": 20},
    )
    waha = _FakeWaha()
    await auto_reply_job(_ctx_rl(waha, _FakePool()), 1)
    assert patched.gen_kwargs["outcall_base_eur"] == 150       # the domicilio base
    assert isinstance(patched.gen_kwargs["outcall_taxi_eur"], int)
    assert patched.gen_kwargs["outcall_taxi_eur"] > 0          # the taxi component
    assert patched.gen_kwargs["outcall_defer"] is False


async def test_location_without_casa_coords_defers(patched, monkeypatch):
    """Client sent a PIN but the casa has no coords → defer (no invented price)."""
    patched.client_location = (39.47, -0.37)
    _patch_knowledge(
        monkeypatch, address_lat=None, address_lng=None,
        outcall={"base_price_eur": 150},
    )
    waha = _FakeWaha()
    await auto_reply_job(_ctx_rl(waha, _FakePool()), 1)
    assert patched.gen_kwargs["outcall_base_eur"] is None
    assert patched.gen_kwargs["outcall_defer"] is True


async def test_location_without_outcall_base_defers(patched, monkeypatch):
    """Client PIN + geocoded casa but no outcall base price → defer."""
    patched.client_location = (39.47, -0.37)
    _patch_knowledge(
        monkeypatch, address_lat=39.4699, address_lng=-0.3763, outcall={},
    )
    waha = _FakeWaha()
    await auto_reply_job(_ctx_rl(waha, _FakePool()), 1)
    assert patched.gen_kwargs["outcall_base_eur"] is None
    assert patched.gen_kwargs["outcall_defer"] is True
