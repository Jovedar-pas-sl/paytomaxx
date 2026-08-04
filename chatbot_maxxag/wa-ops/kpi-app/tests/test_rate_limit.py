"""Unit tests for the per-number ANTI-BAN rate limiter (app.agent.rate_limit).

Pure where possible:
  * in_quiet_hours — OFF when empty/invalid; correct same-day and wrap-past-
    midnight true/false cases (driven via aware datetimes, no monkeypatching).
  * allow_send fail-open — a fake redis that raises on GET must yield
    (True, "redis-error") so infra failure never silences the bot.
  * allow_send caps — a fake redis returning counters at/over a cap blocks; a
    missing key (None) is treated as 0.
  * record_send fail-open — a fake redis whose pipeline raises must not propagate.
  * pace fail-open — a fake redis that raises on GET must not sleep / raise.
"""
from __future__ import annotations

import time
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from app.agent import rate_limit
from app.agent.rate_limit import allow_send, in_quiet_hours, pace, record_send

_MADRID = ZoneInfo("Europe/Madrid")


def _madrid(hour: int, minute: int = 0) -> datetime:
    """Build an Europe/Madrid-aware datetime on a fixed date for quiet-hours tests."""
    return datetime(2026, 6, 16, hour, minute, tzinfo=_MADRID)


# ── in_quiet_hours (pure) ────────────────────────────────────────────
def test_quiet_hours_off_when_empty(monkeypatch):
    """Empty QUIET_HOURS disables the window (these casas are 24/7)."""
    monkeypatch.setattr(rate_limit, "QUIET_HOURS", "")
    assert in_quiet_hours(_madrid(3, 0)) is False


@pytest.mark.parametrize("bad", ["garbage", "25:00-09:00", "02:00", "02:00-", "-09:00", "02:00-02:00"])
def test_quiet_hours_off_when_invalid(monkeypatch, bad):
    """Malformed / out-of-range / zero-length specs disable quiet hours."""
    monkeypatch.setattr(rate_limit, "QUIET_HOURS", bad)
    assert in_quiet_hours(_madrid(5, 0)) is False


def test_quiet_hours_same_day_inside(monkeypatch):
    """02:00-09:00: 05:00 is inside the window → quiet."""
    monkeypatch.setattr(rate_limit, "QUIET_HOURS", "02:00-09:00")
    assert in_quiet_hours(_madrid(5, 0)) is True


def test_quiet_hours_same_day_outside(monkeypatch):
    """02:00-09:00: 12:00 is outside the window → not quiet."""
    monkeypatch.setattr(rate_limit, "QUIET_HOURS", "02:00-09:00")
    assert in_quiet_hours(_madrid(12, 0)) is False


def test_quiet_hours_same_day_end_is_exclusive(monkeypatch):
    """02:00-09:00: 09:00 sharp is the exclusive end → not quiet."""
    monkeypatch.setattr(rate_limit, "QUIET_HOURS", "02:00-09:00")
    assert in_quiet_hours(_madrid(9, 0)) is False


def test_quiet_hours_wrap_true_before_midnight(monkeypatch):
    """22:00-06:00 wraps past midnight: 23:30 is inside → quiet."""
    monkeypatch.setattr(rate_limit, "QUIET_HOURS", "22:00-06:00")
    assert in_quiet_hours(_madrid(23, 30)) is True


def test_quiet_hours_wrap_true_after_midnight(monkeypatch):
    """22:00-06:00 wraps past midnight: 03:00 is inside → quiet."""
    monkeypatch.setattr(rate_limit, "QUIET_HOURS", "22:00-06:00")
    assert in_quiet_hours(_madrid(3, 0)) is True


def test_quiet_hours_wrap_false_midday(monkeypatch):
    """22:00-06:00 wraps past midnight: 12:00 is outside → not quiet."""
    monkeypatch.setattr(rate_limit, "QUIET_HOURS", "22:00-06:00")
    assert in_quiet_hours(_madrid(12, 0)) is False


# ── Fake redis stand-ins ─────────────────────────────────────────────
class _RaisingRedis:
    """Every operation raises — used to prove fail-open behaviour."""

    async def get(self, *_a, **_k):
        raise ConnectionError("redis down")

    async def eval(self, *_a, **_k):
        raise ConnectionError("redis down")

    def pipeline(self):
        raise ConnectionError("redis down")


class _CountingRedis:
    """Returns canned GET values keyed by suffix (min/hour/day); no mutation."""

    def __init__(self, values: dict[str, str | None]) -> None:
        self._values = values

    async def get(self, key: str):
        # key shape: agent:rl:<session>:<suffix>
        suffix = key.rsplit(":", 1)[-1]
        return self._values.get(suffix)


# ── allow_send FAIL-SAFE on redis error ──────────────────────────────
async def test_allow_send_fail_safe_on_redis_error(monkeypatch):
    """A redis whose GET raises → DELEGATE to the in-process fallback (NOT an
    unconditional allow). Fresh fallback + under caps → allowed with reason ''.
    The bot keeps replying but stays under the per-number caps (ban-safe)."""
    # Reset the module fallback so prior tests don't leak counters into this one.
    monkeypatch.setattr(rate_limit, "_fallback", rate_limit._FallbackLimiter())
    allowed, reason = await allow_send(_RaisingRedis(), "vlc")
    assert allowed is True
    assert reason == ""  # fallback under cap → allowed, no fail-open sentinel


async def test_allow_send_none_redis_uses_fallback(monkeypatch):
    """A None redis handle → fallback limiter, not unlimited allow."""
    monkeypatch.setattr(rate_limit, "_fallback", rate_limit._FallbackLimiter())
    allowed, reason = await allow_send(None, "vlc")
    assert allowed is True and reason == ""


async def test_allow_send_fallback_blocks_at_min_cap(monkeypatch):
    """FAIL-SAFE cap: once the fallback has recorded MAX_PER_MIN sends, allow_send
    via a broken redis BLOCKS (reason 'min-cap:fb') — proving the fallback is a
    real cap, not a passthrough."""
    fb = rate_limit._FallbackLimiter()
    monkeypatch.setattr(rate_limit, "_fallback", fb)
    monkeypatch.setattr(rate_limit, "MAX_PER_MIN", 2)
    for _ in range(2):
        await rate_limit.record_send(_RaisingRedis(), "vlc")
    allowed, reason = await allow_send(_RaisingRedis(), "vlc")
    assert allowed is False
    assert reason == "min-cap:fb"


async def test_allow_send_passes_when_under_caps():
    """All counters under their caps → (True, '')."""
    redis = _CountingRedis({"min": "0", "hour": "10", "day": "100"})
    allowed, reason = await allow_send(redis, "vlc")
    assert allowed is True and reason == ""


async def test_allow_send_missing_keys_count_as_zero():
    """Absent counters (None) are treated as 0 → allowed."""
    redis = _CountingRedis({"min": None, "hour": None, "day": None})
    allowed, reason = await allow_send(redis, "vlc")
    assert allowed is True and reason == ""


async def test_allow_send_blocks_on_minute_cap(monkeypatch):
    monkeypatch.setattr(rate_limit, "MAX_PER_MIN", 6)
    redis = _CountingRedis({"min": "6", "hour": "10", "day": "100"})
    allowed, reason = await allow_send(redis, "vlc")
    assert allowed is False and reason == "min-cap"


async def test_allow_send_blocks_on_hour_cap(monkeypatch):
    monkeypatch.setattr(rate_limit, "MAX_PER_MIN", 6)
    monkeypatch.setattr(rate_limit, "MAX_PER_HOUR", 120)
    redis = _CountingRedis({"min": "0", "hour": "120", "day": "200"})
    allowed, reason = await allow_send(redis, "vlc")
    assert allowed is False and reason == "hour-cap"


async def test_allow_send_blocks_on_day_cap(monkeypatch):
    monkeypatch.setattr(rate_limit, "MAX_PER_MIN", 6)
    monkeypatch.setattr(rate_limit, "MAX_PER_HOUR", 120)
    monkeypatch.setattr(rate_limit, "MAX_PER_DAY", 1000)
    redis = _CountingRedis({"min": "0", "hour": "0", "day": "1000"})
    allowed, reason = await allow_send(redis, "vlc")
    assert allowed is False and reason == "day-cap"


# ── pace / record_send FAIL-SAFE ─────────────────────────────────────
async def test_pace_fail_safe_on_redis_error(monkeypatch):
    """pace must not raise when the redis Lua gate fails; it claims the slot from
    the in-process fallback instead. A fresh fallback gate is at/behind now, so no
    real sleep is required — the call returns promptly without raising."""
    monkeypatch.setattr(rate_limit, "_fallback", rate_limit._FallbackLimiter())
    await pace(_RaisingRedis(), "vlc")  # no exception == pass


async def test_pace_none_redis_uses_fallback(monkeypatch):
    """pace with redis=None must not raise — uses the in-process gate."""
    monkeypatch.setattr(rate_limit, "_fallback", rate_limit._FallbackLimiter())
    await pace(None, "vlc")  # no exception == pass


class _GateRedis:
    """Fake redis whose eval (the atomic pacing gate) returns a fixed base epoch."""

    def __init__(self, base: float) -> None:
        self._base = base

    async def eval(self, *_a, **_k):
        return str(self._base)


async def test_pace_no_sleep_when_gate_in_past():
    """Gate base already in the past → nothing to wait for; returns immediately."""
    await pace(_GateRedis(time.time() - 100), "vlc")  # no real sleep, no exception


async def test_record_send_fail_safe_on_pipeline_error(monkeypatch):
    """record_send must swallow a pipeline failure (never propagates) and record
    the send into the in-process fallback so the cap stays accurate."""
    fb = rate_limit._FallbackLimiter()
    monkeypatch.setattr(rate_limit, "_fallback", fb)
    await record_send(_RaisingRedis(), "vlc")  # no exception == pass
    # The send WAS recorded in the fallback (one timestamp for the session).
    assert len(fb._sends.get("vlc", [])) == 1


async def test_record_send_none_redis_records_in_fallback(monkeypatch):
    """record_send with redis=None records into the in-process fallback."""
    fb = rate_limit._FallbackLimiter()
    monkeypatch.setattr(rate_limit, "_fallback", fb)
    await record_send(None, "vlc")
    assert len(fb._sends.get("vlc", [])) == 1


# ── In-process fallback limiter (A7) — direct unit tests ─────────────
async def test_fallback_allows_under_cap(monkeypatch):
    """A fresh fallback under all caps allows the send."""
    monkeypatch.setattr(rate_limit, "MAX_PER_MIN", 6)
    fb = rate_limit._FallbackLimiter()
    allowed, reason = await fb.allow("vlc")
    assert allowed is True and reason == ""


async def test_fallback_blocks_at_minute_cap(monkeypatch):
    """Recording up to MAX_PER_MIN in the same minute window blocks the next."""
    monkeypatch.setattr(rate_limit, "MAX_PER_MIN", 3)
    fb = rate_limit._FallbackLimiter()
    now = time.time()
    for _ in range(3):
        await fb.record("vlc", now=now)
    allowed, reason = await fb.allow("vlc", now=now)
    assert allowed is False and reason == "min-cap"


async def test_fallback_minute_window_slides(monkeypatch):
    """Sends older than the minute window no longer count toward the minute cap."""
    monkeypatch.setattr(rate_limit, "MAX_PER_MIN", 1)
    fb = rate_limit._FallbackLimiter()
    base = time.time()
    await fb.record("vlc", now=base)
    # At base the minute cap (1) is reached → blocked.
    blocked, _ = await fb.allow("vlc", now=base)
    assert blocked is False
    # 61s later the earlier send has aged out of the 60s window → allowed again.
    allowed, _ = await fb.allow("vlc", now=base + 61)
    assert allowed is True


async def test_fallback_pace_claims_spaced_slots(monkeypatch):
    """Two consecutive claim_pace calls return slots spaced MIN_GAP_S apart, so
    concurrent jobs for one number are serialized (anti-ban min-gap)."""
    monkeypatch.setattr(rate_limit, "MIN_GAP_S", 6)
    fb = rate_limit._FallbackLimiter()
    now = 1_000_000.0
    first = await fb.claim_pace("vlc", now=now)
    second = await fb.claim_pace("vlc", now=now)
    assert first == now
    assert second == now + 6  # second caller waits one gap behind the first


async def test_fallback_isolated_per_session(monkeypatch):
    """Caps are per waha_session: one number at cap doesn't block another."""
    monkeypatch.setattr(rate_limit, "MAX_PER_MIN", 1)
    fb = rate_limit._FallbackLimiter()
    now = time.time()
    await fb.record("vlc", now=now)
    blocked, _ = await fb.allow("vlc", now=now)
    other, _ = await fb.allow("madrid", now=now)
    assert blocked is False  # vlc at cap
    assert other is True     # madrid independent


# ── Per-conversation reply lock (anti-duplicate) ─────────────────────
class _FakeLockRedis:
    """Records SET/DELETE; `set_result` controls whether NX SET 'acquires'."""

    def __init__(self, set_result="OK") -> None:
        self._set_result = set_result
        self.deleted: list[str] = []

    async def set(self, key, val, nx=None, ex=None):
        return self._set_result

    async def delete(self, key):
        self.deleted.append(key)
        return 1


async def test_acquire_conv_lock_fail_open_when_no_redis():
    assert await rate_limit.acquire_conv_lock(None, 1) is True


async def test_acquire_conv_lock_true_when_set_acquires():
    assert await rate_limit.acquire_conv_lock(_FakeLockRedis("OK"), 1) is True


async def test_acquire_conv_lock_false_when_lock_held():
    assert await rate_limit.acquire_conv_lock(_FakeLockRedis(None), 1) is False


async def test_acquire_conv_lock_fail_open_on_redis_error():
    class _Boom:
        async def set(self, *a, **k):
            raise RuntimeError("redis down")

    assert await rate_limit.acquire_conv_lock(_Boom(), 1) is True


async def test_release_conv_lock_deletes_the_key():
    r = _FakeLockRedis()
    await rate_limit.release_conv_lock(r, 42)
    assert r.deleted == ["agent:rl:lock:42"]
