"""Unit tests for the abandoned-quote follow-up (app.agent.followup).

Pure where possible:
  * has_price — concrete euro amounts fire; plain numbers / no-price do NOT.
  * in_followup_window — inside/outside the 12:00-05:00 window incl. midnight
    wrap (driven via aware datetimes, no monkeypatching of now).

Job-flow (mocked deps — no DB / LLM / network):
  * followup_sweep_job — enqueues only in-window candidates, respects the cap,
    sends nothing.
  * followup_send_job — SENDS when fully eligible (claims, _send_and_persist
    called with agent_generated=TRUE, record_send called) and SKIPS (no send,
    no claim) when paused_human / not auto / already-followed / client replied /
    no price / outside window / generation "" / anti-ban denies; and the atomic
    claim prevents a double send (second call's claim returns False → no send).
"""
from __future__ import annotations

import types
from dataclasses import dataclass
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from app.agent import followup
from app.agent.followup import (
    followup_send_job,
    followup_sweep_job,
    has_price,
    in_followup_window,
)

_MADRID = ZoneInfo("Europe/Madrid")


def _madrid(hour: int, minute: int = 0) -> datetime:
    """Build an Europe/Madrid-aware datetime on a fixed date for window tests."""
    return datetime(2026, 6, 16, hour, minute, tzinfo=_MADRID)


# ── has_price (pure) ─────────────────────────────────────────────────
@pytest.mark.parametrize(
    "text",
    [
        "la hora son 120€, rey",
        "son 120 € guapo",
        "cuesta €150",
        "€ 200 la sesión",
        "la tarifa es 90 euros",
        "80 euro cariño",
    ],
)
def test_has_price_positive(text):
    """A concrete euro amount (€ symbol or 'euro(s)') is detected."""
    assert has_price(text) is True


@pytest.mark.parametrize(
    "text",
    [
        "te la reservo para esta noche?",     # no number, no price
        "a las 22 te viene bien?",            # bare number = time, not price
        "tengo 2 chicas divinas",             # bare small number
        "",                                    # empty
        None,                                  # None
        "llámame al 600123456",               # phone-like long number, no €/euro
    ],
)
def test_has_price_negative(text):
    """Plain numbers, times, phones and empty text are NOT a price."""
    assert has_price(text) is False


# ── in_followup_window (pure) ────────────────────────────────────────
@pytest.mark.parametrize("hour", [12, 13, 20, 23, 0, 3, 4])
def test_in_followup_window_inside(hour):
    """12:00-05:00 wraps midnight: 12-23 and 0-4 are all inside."""
    assert in_followup_window(_madrid(hour, 0)) is True


@pytest.mark.parametrize("hour", [5, 6, 8, 10, 11])
def test_in_followup_window_outside(hour):
    """05:00-12:00 is outside the window."""
    assert in_followup_window(_madrid(hour, 0)) is False


def test_in_followup_window_start_inclusive():
    """12:00 sharp is inside (inclusive start)."""
    assert in_followup_window(_madrid(12, 0)) is True


def test_in_followup_window_end_exclusive():
    """05:00 sharp is the exclusive end → outside."""
    assert in_followup_window(_madrid(5, 0)) is False


def test_in_followup_window_just_before_midnight():
    """23:59 is inside (wrap branch)."""
    assert in_followup_window(_madrid(23, 59)) is True


def test_in_followup_window_just_after_midnight():
    """00:30 is inside (wrap branch)."""
    assert in_followup_window(_madrid(0, 30)) is True


# ── Stand-ins ────────────────────────────────────────────────────────
@dataclass
class _Detail:
    casa_id: int = 7
    waha_session: str = "vlc"
    contact_jid: str = "34600000001@c.us"
    contact_name: str | None = "Juan"


@dataclass
class _Candidate:
    conversation_id: int
    casa_id: int = 7
    waha_session: str = "vlc"
    chat_id: str = "34600000001@c.us"
    last_agent_body: str = "la hora son 120€, rey 😏"


class _FakeWaha:
    """Records the WAHA sends the job makes."""

    def __init__(self) -> None:
        self.sent: list[tuple[str, str, str]] = []

    async def send_text(self, session: str, chat: str, text: str) -> dict:
        self.sent.append((session, chat, text))
        return {"id": "waha-msg-1"}


class _FakeArq:
    """Records enqueue_job calls (name, args, job_id)."""

    def __init__(self) -> None:
        self.enqueued: list[tuple[str, tuple, str | None]] = []

    async def enqueue_job(self, name, *args, _job_id=None, **kw):
        self.enqueued.append((name, args, _job_id))


# ── Fake asyncpg-like pool (records execs; _send_and_persist uses acquire) ──
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


# ── Sweep job fixture ────────────────────────────────────────────────
@pytest.fixture
def sweep_patched(monkeypatch):
    """Patch the candidate query + window so followup_sweep_job runs pure."""
    rec = types.SimpleNamespace(
        in_window=True,
        candidates=[_Candidate(1), _Candidate(2)],
        listed_limit=None,
    )

    def fake_window(now_local=None):
        return rec.in_window

    async def fake_list(kpi, *, min_silence_min, max_silence_min, limit):
        rec.listed_limit = limit
        return rec.candidates

    monkeypatch.setattr(followup, "in_followup_window", fake_window)
    monkeypatch.setattr(followup.queries, "list_followup_candidates", fake_list)
    return rec


async def test_sweep_enqueues_in_window_candidates_no_send(sweep_patched):
    """In window: each candidate is enqueued as a followup_send_job; no WAHA send."""
    arq = _FakeArq()
    waha = _FakeWaha()
    ctx = {"kpi_db": object(), "arq": arq, "waha": waha}
    await followup_sweep_job(ctx)
    assert [e[0] for e in arq.enqueued] == ["followup_send_job", "followup_send_job"]
    assert [e[1][0] for e in arq.enqueued] == [1, 2]  # conversation ids
    assert waha.sent == []  # the cron NEVER sends


async def test_sweep_skips_out_of_window(sweep_patched):
    """Out of the 12:00-05:00 window the sweep returns immediately (no enqueue)."""
    sweep_patched.in_window = False
    arq = _FakeArq()
    ctx = {"kpi_db": object(), "arq": arq}
    await followup_sweep_job(ctx)
    assert arq.enqueued == []


async def test_sweep_respects_cap(sweep_patched):
    """The sweep passes the per-tick cap to the candidate query."""
    arq = _FakeArq()
    ctx = {"kpi_db": object(), "arq": arq}
    await followup_sweep_job(ctx)
    assert sweep_patched.listed_limit == followup._SWEEP_MAX_CANDIDATES


async def test_sweep_no_arq_handle_does_not_raise(sweep_patched):
    """Missing arq handle is logged + skipped, never raises (no enqueue)."""
    await followup_sweep_job({"kpi_db": object()})  # no "arq" key


# ── Send job fixture ─────────────────────────────────────────────────
@pytest.fixture
def send_patched(monkeypatch):
    """Patch queries + generation + window + anti-ban so followup_send_job runs
    pure. Returns a recorder of the decisions."""
    rec = types.SimpleNamespace(
        mode="auto",
        agent_status=None,
        detail=_Detail(),
        last={"direction": "out", "agent_generated": True, "body": "la hora son 120€, rey"},
        followup_at=None,        # get_followup_at result (None == not yet)
        in_window=True,
        generated="oye guapo, sigo pensando en ti 😏 ¿te la dejo lista?",
        allow=(True, ""),
        claim=True,              # claim_followup result
        # recorders
        claimed=[], paced=[], recorded=[], sent_persist=[],
    )

    async def fake_get_mode(kpi, conv_id):
        return rec.mode

    async def fake_get_status(kpi, conv_id):
        return rec.agent_status

    async def fake_detail(kpi, conv_id):
        return rec.detail

    async def fake_last(kpi, conv_id):
        return rec.last

    async def fake_get_followup_at(kpi, conv_id):
        return rec.followup_at

    def fake_window(now_local=None):
        return rec.in_window

    async def fake_generate(kpi, **kw):
        return rec.generated

    async def fake_allow(redis, session):
        return rec.allow

    async def fake_pace(redis, session):
        rec.paced.append(session)

    async def fake_record(redis, session):
        rec.recorded.append(session)

    async def fake_claim(kpi, conv_id):
        rec.claimed.append(conv_id)
        return rec.claim

    async def fake_send_and_persist(kpi, waha, conv_id, session, chat, reply):
        # Mirror the real send so tests can assert it was reached + persists.
        await waha.send_text(session, chat, reply)
        rec.sent_persist.append((conv_id, session, chat, reply))

    async def fast_sleep(_):
        return None

    monkeypatch.setattr(followup.queries, "get_wa_mode_for_conversation", fake_get_mode)
    monkeypatch.setattr(followup.queries, "get_conversation_agent_status", fake_get_status)
    monkeypatch.setattr(followup.queries, "get_conversation_detail", fake_detail)
    monkeypatch.setattr(followup.queries, "get_followup_at", fake_get_followup_at)
    monkeypatch.setattr(followup.queries, "claim_followup", fake_claim)
    monkeypatch.setattr(followup, "_last_message", fake_last)
    monkeypatch.setattr(followup, "in_followup_window", fake_window)
    monkeypatch.setattr(followup.reply_engine, "generate_followup_text", fake_generate)
    monkeypatch.setattr(followup.rate_limit, "allow_send", fake_allow)
    monkeypatch.setattr(followup.rate_limit, "pace", fake_pace)
    monkeypatch.setattr(followup.rate_limit, "record_send", fake_record)
    monkeypatch.setattr(followup, "_send_and_persist", fake_send_and_persist)
    monkeypatch.setattr(followup.asyncio, "sleep", fast_sleep)
    return rec


def _ctx_rl(waha):
    """Send-job ctx WITH a redis handle so the anti-ban path is exercised."""
    return {"kpi_db": _FakePool(), "waha": waha, "redis": object()}


async def test_send_when_fully_eligible(send_patched):
    """All guards pass → claims, sends (agent_generated via _send_and_persist),
    paces then records, keyed by session."""
    waha = _FakeWaha()
    await followup_send_job(_ctx_rl(waha), 1)
    assert waha.sent and waha.sent[0][2] == send_patched.generated
    assert send_patched.claimed == [1]
    assert send_patched.sent_persist and send_patched.sent_persist[0][0] == 1
    assert send_patched.paced == [send_patched.detail.waha_session]
    assert send_patched.recorded == [send_patched.detail.waha_session]


async def test_send_persist_uses_agent_generated_path():
    """_send_and_persist itself writes agent_generated=TRUE (the real helper)."""
    # Exercise the REAL _send_and_persist with a fake pool + waha to confirm the
    # INSERT carries agent_generated=TRUE so the nudge isn't misread next turn.
    from app.agent.auto_reply import _send_and_persist
    pool = _FakePool()
    waha = _FakeWaha()
    await _send_and_persist(pool, waha, 1, "vlc", "34600000001@c.us", "hola guapo")
    assert waha.sent == [("vlc", "34600000001@c.us", "hola guapo")]
    assert any("agent_generated" in sql.lower() or "TRUE" in sql for sql in pool.conn.execs)


async def test_skip_not_auto(send_patched):
    """mode != auto (off/copilot) → no send, no claim."""
    send_patched.mode = "copilot"
    waha = _FakeWaha()
    await followup_send_job(_ctx_rl(waha), 1)
    assert waha.sent == [] and send_patched.claimed == []


async def test_skip_paused_human(send_patched):
    """paused_human → never talk over a human; no send, no claim."""
    send_patched.agent_status = "paused_human"
    waha = _FakeWaha()
    await followup_send_job(_ctx_rl(waha), 1)
    assert waha.sent == [] and send_patched.claimed == []


async def test_skip_paused_risk(send_patched):
    """paused_risk → safety pause; no send, no claim."""
    send_patched.agent_status = "paused_risk"
    waha = _FakeWaha()
    await followup_send_job(_ctx_rl(waha), 1)
    assert waha.sent == [] and send_patched.claimed == []


async def test_skip_already_followed(send_patched):
    """agent_followup_at already set (early read) → no send, no claim."""
    send_patched.followup_at = datetime.now(_MADRID)
    waha = _FakeWaha()
    await followup_send_job(_ctx_rl(waha), 1)
    assert waha.sent == [] and send_patched.claimed == []


async def test_skip_client_replied_after_quote(send_patched):
    """Last message is now the client's inbound → not abandoned; no send/claim."""
    send_patched.last = {"direction": "in", "agent_generated": False, "body": "vale"}
    waha = _FakeWaha()
    await followup_send_job(_ctx_rl(waha), 1)
    assert waha.sent == [] and send_patched.claimed == []


async def test_skip_no_price_in_last_quote(send_patched):
    """The last agent message quoted no price → no offer to follow up; skip."""
    send_patched.last = {
        "direction": "out", "agent_generated": True,
        "body": "te la reservo para esta noche?",
    }
    waha = _FakeWaha()
    await followup_send_job(_ctx_rl(waha), 1)
    assert waha.sent == [] and send_patched.claimed == []


async def test_skip_stale_quote_at_send_time(send_patched):
    """Send-time staleness backstop: a priced quote that is now far older than the
    sweep window (queue backlog) → no nudge, no claim."""
    send_patched.last = {
        "direction": "out", "agent_generated": True,
        "body": "la hora son 120€, rey", "age_min": 200.0,  # well past 2x sweep max
    }
    waha = _FakeWaha()
    await followup_send_job(_ctx_rl(waha), 1)
    assert waha.sent == [] and send_patched.claimed == []


async def test_skip_outside_window(send_patched):
    """Window closed since the sweep → no send, no claim."""
    send_patched.in_window = False
    waha = _FakeWaha()
    await followup_send_job(_ctx_rl(waha), 1)
    assert waha.sent == [] and send_patched.claimed == []


async def test_skip_empty_generation(send_patched):
    """generate_followup_text returns "" → SKIP (never send a generic nudge),
    no claim."""
    send_patched.generated = ""
    waha = _FakeWaha()
    await followup_send_job(_ctx_rl(waha), 1)
    assert waha.sent == [] and send_patched.claimed == []


async def test_skip_anti_ban_denies(send_patched):
    """allow_send denies (at cap) → no send, no claim, no record."""
    send_patched.allow = (False, "min-cap")
    waha = _FakeWaha()
    await followup_send_job(_ctx_rl(waha), 1)
    assert waha.sent == []
    assert send_patched.claimed == []      # gated BEFORE the claim
    assert send_patched.recorded == []


async def test_atomic_claim_prevents_double_send(send_patched):
    """The atomic claim is the max-1 guard: when claim_followup returns False
    (another job won), no send / no record even though all other guards pass."""
    send_patched.claim = False
    waha = _FakeWaha()
    await followup_send_job(_ctx_rl(waha), 1)
    assert send_patched.claimed == [1]     # the claim WAS attempted
    assert waha.sent == []                 # but lost → no send
    assert send_patched.recorded == []


async def test_send_job_never_raises(send_patched, monkeypatch):
    """An unexpected error inside the send path is wrapped + logged, never raised."""
    async def boom(kpi, conv_id):
        raise RuntimeError("db down")

    monkeypatch.setattr(followup.queries, "get_wa_mode_for_conversation", boom)
    waha = _FakeWaha()
    await followup_send_job(_ctx_rl(waha), 1)  # no exception == pass
    assert waha.sent == []


async def test_send_fail_safe_without_redis(send_patched):
    """No redis handle (FAIL-SAFE): still sends + claims, and STILL invokes the
    rate-limit calls (which the limiter degrades to an in-process fallback) — the
    anti-ban gate is never skipped, so a missing Redis can't unleash a ban-risk
    burst. allow_send/pace/record are passed redis=None and handle it internally;
    here they are the fixture fakes, so we only assert they were called."""
    waha = _FakeWaha()
    ctx = {"kpi_db": _FakePool(), "waha": waha}  # no "redis"
    await followup_send_job(ctx, 1)
    assert waha.sent
    assert send_patched.claimed == [1]
    assert send_patched.paced == [send_patched.detail.waha_session]      # gated
    assert send_patched.recorded == [send_patched.detail.waha_session]   # counted
