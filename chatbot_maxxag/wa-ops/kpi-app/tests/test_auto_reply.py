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
    _detect_girl_request,
    _detect_time_request,
    _humanize_typing_seconds,
    _phone_to_chat_id,
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


# ── _phone_to_chat_id (pure) ─────────────────────────────────────────
def test_phone_to_chat_id_strips_to_digits():
    assert _phone_to_chat_id("+34 603 201 414") == "34603201414@c.us"
    assert _phone_to_chat_id("0034-999-888-777") == "0034999888777@c.us"


def test_phone_to_chat_id_rejects_empty_or_short():
    assert _phone_to_chat_id("") is None
    assert _phone_to_chat_id(None) is None
    assert _phone_to_chat_id("123") is None


# ── _detect_girl_request (pure) ──────────────────────────────────────
def test_detect_girl_request_matches_whole_word_case_insensitive():
    names = ["Yesenia", "Madison", "Ana"]
    assert _detect_girl_request("hola, ¿está YESENIA hoy?", names) == "Yesenia"
    assert _detect_girl_request("quiero a madison", names) == "Madison"


def test_detect_girl_request_no_match_returns_none():
    names = ["Yesenia", "Madison"]
    assert _detect_girl_request("quiero info y precio", names) is None
    assert _detect_girl_request("", names) is None


def test_detect_girl_request_ignores_substring_and_short_names():
    # 'Ana' must not match inside 'mañana'/'banana'; <3-char names are skipped.
    assert _detect_girl_request("nos vemos mañana", ["Ana"]) is None
    assert _detect_girl_request("hola", ["Jo"]) is None


# ── _detect_time_request (pure) ──────────────────────────────────────
def test_detect_time_request_matches_common_expressions():
    assert _detect_time_request("¿puede a las 10?") is True
    assert _detect_time_request("sobre las 22h") is True
    assert _detect_time_request("a las 22:30") is True
    assert _detect_time_request("¿ahora mismo?") is True
    assert _detect_time_request("esta noche") is True


def test_detect_time_request_no_time_is_false():
    assert _detect_time_request("hola, ¿qué chicas hay?") is False
    assert _detect_time_request("") is False


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
        # Idempotency guard: True → Sara already answered this turn (skip at start).
        already_replied=False,
        # Duplicate backstop: True → another Sara reply lands DURING the human-like
        # delay (the post-delay re-check aborts the send). last_agent_calls tracks
        # which last_out_is_agent_generated call we're on (1 = start guard).
        replied_during_delay=False,
        last_agent_calls=0,
        # Outcall handoff: True → an unacked 'outcall_handoff' alert already exists
        # for this conv (has_open_alert), so the notice must NOT be re-inserted.
        open_alert=False,
        # Encargada heads-up: recepción number + the casa's girl names + the last
        # incoming text (so a test can trigger the specific-girl detection). manual
        # = the casa's Backoffice mode (False → web-sync: girl-name verify path).
        recepcion="+34 999 888 777",
        girl_names=["Yesenia", "Madison"],
        incoming_text="hola precio?",
        manual=False,
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
        rec.last_agent_calls += 1
        # 1st call = the start idempotency guard; a later call = the post-delay
        # duplicate backstop (only reached in auto mode, after the human delay).
        if rec.last_agent_calls == 1:
            return rec.already_replied
        return rec.replied_during_delay

    async def fake_detail(kpi, conv_id):
        return rec.detail

    async def fake_insert_alert(kpi, **kw):
        rec.alerts.append(kw)

    async def fake_has_open_alert(kpi, conv_id, type):
        return rec.open_alert

    async def fake_get_recepcion(kpi, casa_id):
        return rec.recepcion

    async def fake_get_girl_names(kpi, casa_id):
        return rec.girl_names

    async def fake_get_manual_mode(kpi, casa_id):
        return rec.manual

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
        return [Message(ts=1, role="cliente", content=rec.incoming_text)]

    async def fast_sleep(_):  # no real delay in tests
        return None

    monkeypatch.setattr(auto_reply.queries, "get_wa_mode_for_conversation", fake_get_mode)
    monkeypatch.setattr(auto_reply.queries, "get_conversation_agent_status", fake_get_status)
    monkeypatch.setattr(auto_reply.queries, "set_conversation_agent_status", fake_set_status)
    monkeypatch.setattr(auto_reply.queries, "has_recent_human_outbound", fake_has_recent)
    monkeypatch.setattr(auto_reply.queries, "last_out_is_agent_generated", fake_last_agent)
    monkeypatch.setattr(auto_reply.queries, "get_conversation_detail", fake_detail)
    monkeypatch.setattr(auto_reply.queries, "insert_alert", fake_insert_alert)
    monkeypatch.setattr(auto_reply.queries, "has_open_alert", fake_has_open_alert)
    monkeypatch.setattr(auto_reply.queries, "get_casa_recepcion", fake_get_recepcion)
    monkeypatch.setattr(auto_reply.queries, "get_active_girl_names", fake_get_girl_names)
    monkeypatch.setattr(auto_reply.queries, "get_casa_manual_mode", fake_get_manual_mode)
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


async def test_skips_when_already_replied_to_turn(patched):
    """Idempotency: if Sara already answered the latest turn (the newest message is
    her agent-generated outbound), the job bails BEFORE generating or sending —
    kills the duplicate reply from an arq retry or the WAHA message/message.any
    double-event."""
    patched.already_replied = True
    waha = _FakeWaha()
    await auto_reply_job(_ctx(waha), 1)
    assert waha.sent == []
    assert patched.generated is False
    assert patched.statuses == []


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
    assert patched.gen_kwargs["outcall_taxi_low"] is None
    assert patched.gen_kwargs["outcall_taxi_high"] is None
    assert patched.gen_kwargs["outcall_defer"] is False


async def test_location_with_geo_passes_precomputed_range(patched, monkeypatch):
    """Client PIN + geocoded casa + base price → a precomputed base + taxi RANGE
    (low < high, both > 0) is handed to generate_reply (defer False)."""
    patched.client_location = (39.47, -0.37)  # ~near the Valencia casa
    _patch_knowledge(
        monkeypatch, address_lat=39.4699, address_lng=-0.3763,
        outcall={"base_price_eur": 150, "taxi_surcharge_pct": 20},
    )
    waha = _FakeWaha()
    await auto_reply_job(_ctx_rl(waha, _FakePool()), 1)
    assert patched.gen_kwargs["outcall_base_eur"] == 150       # the domicilio base
    low = patched.gen_kwargs["outcall_taxi_low"]
    high = patched.gen_kwargs["outcall_taxi_high"]
    assert isinstance(low, int) and isinstance(high, int)
    assert 0 < low < high                                       # a real taxi range
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


# ── Outcall handoff alert (notify the casa when a salida is closing) ─
async def test_outcall_pin_inserts_handoff_alert(patched, monkeypatch):
    """A location PIN for a priced outcall notifies the casa with a one-off
    'outcall_handoff' alert so the team takes over the real-time-location close."""
    patched.client_location = (39.47, -0.37)
    _patch_knowledge(
        monkeypatch, address_lat=39.4699, address_lng=-0.3763,
        outcall={"base_price_eur": 150, "taxi_surcharge_pct": 20},
    )
    waha = _FakeWaha()
    await auto_reply_job(_ctx_rl(waha, _FakePool()), 1)
    handoffs = [a for a in patched.alerts if a.get("type") == "outcall_handoff"]
    assert len(handoffs) == 1
    assert handoffs[0]["severity"] == "info"
    assert "salida" in handoffs[0]["message"].lower()


async def test_outcall_defer_also_inserts_handoff_alert(patched, monkeypatch):
    """Even a DEFER (pin sent, no price yet) is a closing-salida signal → alert."""
    patched.client_location = (39.47, -0.37)
    _patch_knowledge(
        monkeypatch, address_lat=None, address_lng=None,
        outcall={"base_price_eur": 150},
    )
    waha = _FakeWaha()
    await auto_reply_job(_ctx_rl(waha, _FakePool()), 1)
    assert any(a.get("type") == "outcall_handoff" for a in patched.alerts)


async def test_no_location_no_handoff_alert(patched):
    """No PIN → no closing-salida signal → no handoff alert."""
    patched.client_location = None
    waha = _FakeWaha()
    await auto_reply_job(_ctx_rl(waha, _FakePool()), 1)
    assert not any(a.get("type") == "outcall_handoff" for a in patched.alerts)


async def test_handoff_alert_is_idempotent(patched, monkeypatch):
    """An already-open handoff alert for the conv → do NOT insert a duplicate."""
    patched.open_alert = True
    patched.client_location = (39.47, -0.37)
    _patch_knowledge(
        monkeypatch, address_lat=39.4699, address_lng=-0.3763,
        outcall={"base_price_eur": 150, "taxi_surcharge_pct": 20},
    )
    waha = _FakeWaha()
    await auto_reply_job(_ctx_rl(waha, _FakePool()), 1)
    assert not any(a.get("type") == "outcall_handoff" for a in patched.alerts)


# ── Encargada WhatsApp heads-up (outcall closing + specific girl) ────
_RECEPCION_CHAT = "34999888777@c.us"  # matches rec.recepcion "+34 999 888 777"


async def test_outcall_pin_notifies_encargada_whatsapp(patched, monkeypatch):
    """Closing a salida sends a WA heads-up to the casa's recepción number."""
    patched.client_location = (39.47, -0.37)
    _patch_knowledge(
        monkeypatch, address_lat=39.4699, address_lng=-0.3763,
        outcall={"base_price_eur": 150, "taxi_surcharge_pct": 20},
    )
    waha = _FakeWaha()
    await auto_reply_job(_ctx_rl(waha, _FakePool()), 1)
    to_recepcion = [s for s in waha.sent if s[1] == _RECEPCION_CHAT]
    assert len(to_recepcion) == 1
    assert "salida" in to_recepcion[0][2].lower()


async def test_specific_girl_request_notifies_encargada(patched):
    """A client naming a real girl → the encargada gets a WA with her name to
    verify availability, plus a 'girl_request' alert."""
    patched.incoming_text = "hola, ¿está Yesenia disponible?"
    waha = _FakeWaha()
    await auto_reply_job(_ctx_rl(waha, _FakePool()), 1)
    to_recepcion = [s for s in waha.sent if s[1] == _RECEPCION_CHAT]
    assert len(to_recepcion) == 1
    assert "Yesenia" in to_recepcion[0][2]
    assert any(a.get("type") == "girl_request" for a in patched.alerts)


class _FakeWahaNotifyFails(_FakeWaha):
    """send_text raises ONLY for the recepción number → the notify send fails while
    the normal client reply still goes through."""

    async def send_text(self, session: str, chat: str, text: str) -> dict:
        if chat == _RECEPCION_CHAT:
            raise RuntimeError("waha down")
        return await super().send_text(session, chat, text)


async def test_notify_send_failure_does_not_mark_done_so_it_retries(patched):
    """If the encargada WA send fails, the dedup alert is NOT written — so the next
    trigger retries instead of silently marking the heads-up done."""
    patched.incoming_text = "¿está Yesenia?"
    waha = _FakeWahaNotifyFails()
    await auto_reply_job(_ctx_rl(waha, _FakePool()), 1)
    assert not any(a.get("type") == "girl_request" for a in patched.alerts)


async def test_no_girl_named_no_encargada_ping(patched):
    """A generic message (no girl name) → no girl_request alert, no WA to recepción."""
    patched.incoming_text = "hola, ¿precio de una hora?"
    waha = _FakeWaha()
    await auto_reply_job(_ctx_rl(waha, _FakePool()), 1)
    assert not any(a.get("type") == "girl_request" for a in patched.alerts)
    assert not any(s[1] == _RECEPCION_CHAT for s in waha.sent)


async def test_notify_encargada_skips_wa_when_no_recepcion_number(patched):
    """No recepción number configured → the panel alert is still recorded, but no
    WA is attempted (nothing to send to)."""
    patched.recepcion = None
    patched.incoming_text = "¿está Madison?"
    waha = _FakeWaha()
    await auto_reply_job(_ctx_rl(waha, _FakePool()), 1)
    assert any(a.get("type") == "girl_request" for a in patched.alerts)
    assert not any(s[1] == _RECEPCION_CHAT for s in waha.sent)


# ── Booking-close heads-up (concrete data → the casa's own recepción number) ──
def test_detect_booking_intent():
    assert auto_reply._detect_booking_intent("vale resérvame porfa")
    assert auto_reply._detect_booking_intent("quiero reservar")
    assert auto_reply._detect_booking_intent("me la reservas?")
    assert not auto_reply._detect_booking_intent("hola cuánto cuesta")
    assert not auto_reply._detect_booking_intent("")


async def test_booking_intent_pings_recepcion(patched):
    """Explicit 'resérvame' (no girl/time) → a one-off 'booking_close' alert AND a
    WhatsApp to the casa's OWN recepción number."""
    patched.incoming_text = "vale resérvame porfa"
    waha = _FakeWaha()
    await auto_reply_job(_ctx_rl(waha, _FakePool()), 1)
    closes = [a for a in patched.alerts if a.get("type") == "booking_close"]
    assert len(closes) == 1
    assert any(chat == _RECEPCION_CHAT for _s, chat, _t in waha.sent)


async def test_close_with_named_girl_prefers_booking_close(patched):
    """Web casa + a named girl WITH a close signal ('resérvame') → the close framing
    WINS by precedence: booking_close fires (mentioning the girl), girl_request does
    NOT, and recepción gets exactly ONE ping."""
    patched.incoming_text = "resérvame a Yesenia"
    waha = _FakeWaha()
    await auto_reply_job(_ctx_rl(waha, _FakePool()), 1)
    closes = [a for a in patched.alerts if a.get("type") == "booking_close"]
    assert len(closes) == 1
    assert "Yesenia" in closes[0]["message"]
    assert not any(a.get("type") == "girl_request" for a in patched.alerts)
    assert sum(1 for _s, chat, _t in waha.sent if chat == _RECEPCION_CHAT) == 1


async def test_web_time_pings_booking_close(patched):
    """Web casa + a proposed time (no girl) → the mode heads-up doesn't fire in web
    mode, so booking_close covers it → recepción is pinged to take the close."""
    patched.incoming_text = "puede a las 22h?"
    waha = _FakeWaha()
    await auto_reply_job(_ctx_rl(waha, _FakePool()), 1)
    assert any(a.get("type") == "booking_close" for a in patched.alerts)
    assert any(chat == _RECEPCION_CHAT for _s, chat, _t in waha.sent)


async def test_bare_girl_name_no_booking_close(patched):
    """A bare girl name (no time / no 'resérvame') is NOT a close signal → no
    booking_close (manual trusts the roster; web pings via girl_request instead)."""
    patched.manual = True
    patched.incoming_text = "quiero a Yesenia"
    waha = _FakeWaha()
    await auto_reply_job(_ctx_rl(waha, _FakePool()), 1)
    assert not any(a.get("type") == "booking_close" for a in patched.alerts)


async def test_no_concrete_data_no_booking_close(patched):
    """A vague message (no time / girl / booking word) → no booking-close ping."""
    patched.incoming_text = "hola, ¿cuánto cuesta?"
    waha = _FakeWaha()
    await auto_reply_job(_ctx_rl(waha, _FakePool()), 1)
    assert not any(a.get("type") == "booking_close" for a in patched.alerts)


async def test_booking_close_is_idempotent(patched):
    """An already-open booking_close alert for the conv → no duplicate."""
    patched.open_alert = True
    patched.incoming_text = "resérvame"
    waha = _FakeWaha()
    await auto_reply_job(_ctx_rl(waha, _FakePool()), 1)
    assert not any(a.get("type") == "booking_close" for a in patched.alerts)


async def test_booking_close_fires_even_if_girl_request_already_open(patched, monkeypatch):
    """Cross-message close (regression): the girl was asked about on an EARLIER turn
    (girl_request already open → a deduped no-op now), and the client now closes
    re-mentioning her + a time. booking_close must STILL fire — a concrete close takes
    precedence and has its OWN once-per-conversation dedup, so a prior-turn girl_request
    never swallows the real close."""
    async def only_headsup_open(kpi, conv_id, tag):
        return tag in ("girl_request", "time_check")  # booking_close NOT yet open
    monkeypatch.setattr(auto_reply.queries, "has_open_alert", only_headsup_open)
    patched.incoming_text = "vale resérvame a Yesenia a las 22h"
    waha = _FakeWaha()
    await auto_reply_job(_ctx_rl(waha, _FakePool()), 1)
    assert any(a.get("type") == "booking_close" for a in patched.alerts)


# ── Manual (Backoffice) mode: HOUR is confirmed, girl availability is NOT ────
async def test_manual_mode_time_request_notifies_encargada(patched):
    """Manual casa + the client proposes an hour → it's a close, so booking_close
    fires (superseding the old time_check) with the girl+hour context in ONE WA; no
    separate time_check/girl_request ping."""
    patched.manual = True
    patched.incoming_text = "¿puede Yesenia a las 22h?"
    waha = _FakeWaha()
    await auto_reply_job(_ctx_rl(waha, _FakePool()), 1)
    closes = [a for a in patched.alerts if a.get("type") == "booking_close"]
    assert len(closes) == 1
    assert not any(a.get("type") in ("time_check", "girl_request") for a in patched.alerts)
    to_recepcion = [s for s in waha.sent if s[1] == _RECEPCION_CHAT]
    assert len(to_recepcion) == 1
    assert "cerrando" in to_recepcion[0][2].lower()


async def test_manual_mode_girl_without_time_no_verify_ping(patched):
    """Manual casa: the roster is trusted, so naming a girl (no time) does NOT
    trigger a girl-availability verify — no ping."""
    patched.manual = True
    patched.incoming_text = "quiero a Yesenia"
    waha = _FakeWaha()
    await auto_reply_job(_ctx_rl(waha, _FakePool()), 1)
    assert not any(a.get("type") in ("girl_request", "time_check") for a in patched.alerts)
    assert not any(s[1] == _RECEPCION_CHAT for s in waha.sent)


# ── Anti-duplicate: conv lock + post-delay idempotency re-check ──────
class _FakeRedisLocked:
    """A redis stub whose NX SET always fails → the conv lock is 'held'."""

    async def set(self, *a, **k):
        return None

    async def delete(self, *a, **k):
        return 1


def _ctx_locked(waha):
    return {"kpi_db": _FakePool(), "waha": waha, "redis": _FakeRedisLocked()}


async def test_conv_lock_held_skips_job_entirely(patched):
    """Another job holds the per-conversation lock → this job bails BEFORE any
    generate/send (kills the concurrent double-reply)."""
    waha = _FakeWaha()
    await auto_reply_job(_ctx_locked(waha), 1)
    assert patched.generated is False
    assert waha.sent == []
    assert patched.alerts == []


async def test_reply_landing_during_delay_aborts_send(patched):
    """Start guard passes, but ANOTHER Sara reply lands during the human-like delay
    → the post-delay re-check aborts the send (no duplicate)."""
    patched.already_replied = False       # start guard: not yet answered
    patched.replied_during_delay = True   # a reply lands during the delay
    waha = _FakeWaha()
    await auto_reply_job(_ctx_rl(waha, _FakePool()), 1)
    assert patched.generated is True      # we did generate (before the delay)
    assert waha.sent == []                # …but never sent (aborted post-delay)
