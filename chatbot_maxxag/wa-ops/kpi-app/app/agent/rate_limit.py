"""Per-number ANTI-BAN rate limiting for the WhatsApp agent (auto mode only).

The agent auto-sends on unofficial WhatsApp numbers (WAHA). Per-conversation
debounce + human-like delays already exist, but nothing caps the AGGREGATE
outbound rate per NUMBER — the main remaining ban vector. This module adds
Redis-backed limits keyed by the per-number WAHA session (`waha_session`):

  * a minimum gap between two consecutive auto-sends on the SAME number,
  * fixed-window counters for per-minute / per-hour / per-day caps,
  * optional quiet hours (off by default — these casas are 24/7).

DESIGN INVARIANTS (CLAUDE.md):
  * FAIL-OPEN everywhere — a limiter/Redis error must NEVER silence the bot.
    On any Redis exception we log a warning and behave as if the limit allowed
    the send (counters not updated, no pacing sleep).
  * The bounded pacing sleep (<= MIN_GAP_S) lives in the auto_reply JOB, not in
    the health-check cron loop (a long sleep there would block the loop).
  * ONLY auto mode is rate-limited; copilot never sends, so it is never gated.

Redis keys (namespaced per session):
    agent:rl:<session>:min   — fixed-window counter, TTL 60s
    agent:rl:<session>:hour  — fixed-window counter, TTL 3600s
    agent:rl:<session>:day   — fixed-window counter, TTL 86400s
    agent:rl:<session>:gate  — next-allowed-send epoch (atomic pacing gate)
"""
from __future__ import annotations

import asyncio
import logging
import os
import random
import time
from datetime import datetime
from datetime import time as dtime
from zoneinfo import ZoneInfo

logger = logging.getLogger("agent.rate_limit")

# ── Timezone ─────────────────────────────────────────────────────────
# Quiet hours are interpreted in local (Spain) wall-clock time.
_MADRID = ZoneInfo("Europe/Madrid")

# ── Redis key namespace ──────────────────────────────────────────────
_KEY_PREFIX = "agent:rl"


def _env_int(name: str, default: int) -> int:
    """Parse an int env override; fall back to the default on missing/invalid."""
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except (TypeError, ValueError):
        logger.warning("rate_limit: invalid int env %s=%r — using default %s", name, raw, default)
        return default


def _env_str(name: str, default: str) -> str:
    """Parse a str env override; fall back to the default on missing."""
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip()


# ── Tunable defaults (overridable via env) ───────────────────────────
# Minimum seconds between two auto-sends on the SAME number (serializes
# concurrent sends to one number without dropping replies).
MIN_GAP_S: int = _env_int("AGENT_RL_MIN_GAP_S", 6)
# Fixed-window aggregate caps per NUMBER (waha_session).
MAX_PER_MIN: int = _env_int("AGENT_RL_MAX_PER_MIN", 6)
MAX_PER_HOUR: int = _env_int("AGENT_RL_MAX_PER_HOUR", 120)
MAX_PER_DAY: int = _env_int("AGENT_RL_MAX_PER_DAY", 1000)
# Quiet hours window in Europe/Madrid local time, "HH:MM-HH:MM". Empty = OFF
# (these casas are 24/7). Supports wrap past midnight (e.g. "02:00-09:00").
QUIET_HOURS: str = _env_str("AGENT_RL_QUIET_HOURS", "")

# Fixed-window TTLs (seconds) — also the window sizes.
_WINDOW_MIN_S = 60
_WINDOW_HOUR_S = 3600
_WINDOW_DAY_S = 86400

# Pacing gate: the gate key holds the next-allowed-send epoch for a number. Each
# caller atomically claims a slot MIN_GAP_S after the previous claim, so
# concurrent jobs for the SAME number are truly serialized (not just each reading
# the same stale timestamp). The wait is capped so a pathological burst never
# ties up a worker (the per-minute cap already bounds volume).
_GATE_TTL_S = 120
_MAX_PACE_WAIT_S = 30.0
# Bounded random jitter (s) added on top of the pacing sleep so the inter-send
# gap is NOT a mechanically-fixed MIN_GAP_S — fixed regularity is a behavioral
# ban tell on unofficial numbers. Only applied when there is a real wait.
_PACE_JITTER_S = 3.0

# Atomic claim of the next send slot — runs under Redis' single-threaded eval, so
# concurrent claims are serialized. Returns the epoch this caller may send at
# (>= now). KEYS[1]=gate key; ARGV: now, gap, ttl.
_GATE_LUA = (
    "local g = tonumber(redis.call('GET', KEYS[1]) or '0')\n"
    "local now = tonumber(ARGV[1])\n"
    "local base = now\n"
    "if g > now then base = g end\n"
    "redis.call('SET', KEYS[1], base + tonumber(ARGV[2]), 'EX', ARGV[3])\n"
    "return tostring(base)"
)


def _key(session: str, suffix: str) -> str:
    """Build a per-session Redis key, e.g. agent:rl:<session>:min."""
    return f"{_KEY_PREFIX}:{session}:{suffix}"


def _parse_hhmm(token: str) -> dtime | None:
    """Parse an "HH:MM" token into a time, or None if malformed."""
    parts = token.strip().split(":")
    if len(parts) != 2:
        return None
    try:
        hh, mm = int(parts[0]), int(parts[1])
    except (TypeError, ValueError):
        return None
    if not (0 <= hh <= 23 and 0 <= mm <= 59):
        return None
    return dtime(hour=hh, minute=mm)


def in_quiet_hours(now_local: datetime | None = None) -> bool:
    """Return True if `now_local` falls inside the configured quiet-hours window.

    Pure and testable. QUIET_HOURS format is "HH:MM-HH:MM" in Europe/Madrid.
    An empty or invalid value disables quiet hours (returns False) — these casas
    run 24/7 by default. The window may wrap past midnight: e.g. "02:00-09:00"
    means 02:00 → 09:00, while "22:00-06:00" means 22:00 → next-day 06:00.

    A zero-length window (start == end) is treated as OFF (never quiet) rather
    than always-quiet, so a misconfigured equal pair never silences the bot.
    """
    spec = QUIET_HOURS.strip()
    if not spec:
        return False
    if "-" not in spec:
        return False
    start_tok, _, end_tok = spec.partition("-")
    start = _parse_hhmm(start_tok)
    end = _parse_hhmm(end_tok)
    if start is None or end is None or start == end:
        return False

    now = now_local or datetime.now(_MADRID)
    current = now.timetz() if now.tzinfo else now.time()
    current = dtime(hour=current.hour, minute=current.minute)

    if start < end:
        # Same-day window, e.g. 02:00-09:00.
        return start <= current < end
    # Wrap past midnight, e.g. 22:00-06:00.
    return current >= start or current < end


class _FallbackLimiter:
    """Per-process anti-ban fallback for when Redis is None or erroring.

    Keeps per-session send timestamps + a per-session pacing gate so the SAME
    fixed-window caps (MAX_PER_MIN/HOUR/DAY) and MIN_GAP_S pacing still apply
    during a Redis outage — closing the previous "no Redis → no anti-ban" hole
    (the primary documented ban vector). In-memory and best-effort (not shared
    across processes), pruned to the day window so it stays bounded. Methods take
    an optional `now` for deterministic tests.
    """

    def __init__(self) -> None:
        self._sends: dict[str, list[float]] = {}
        self._gate: dict[str, float] = {}

    def _prune(self, session: str, now: float) -> list[float]:
        cutoff = now - _WINDOW_DAY_S
        kept = [t for t in self._sends.get(session, []) if t >= cutoff]
        self._sends[session] = kept
        return kept

    async def allow(self, session: str, now: float | None = None) -> tuple[bool, str]:
        now = time.time() if now is None else now
        kept = self._prune(session, now)
        min_n = sum(1 for t in kept if t >= now - _WINDOW_MIN_S)
        hour_n = sum(1 for t in kept if t >= now - _WINDOW_HOUR_S)
        day_n = len(kept)
        if min_n >= MAX_PER_MIN:
            return False, "min-cap"
        if hour_n >= MAX_PER_HOUR:
            return False, "hour-cap"
        if day_n >= MAX_PER_DAY:
            return False, "day-cap"
        return True, ""

    async def record(self, session: str, now: float | None = None) -> None:
        now = time.time() if now is None else now
        self._sends.setdefault(session, []).append(now)
        self._prune(session, now)

    async def claim_pace(self, session: str, now: float | None = None) -> float:
        """Claim the next send slot, MIN_GAP_S behind the previous claim (so two
        concurrent claims for one number are spaced, not simultaneous)."""
        now = time.time() if now is None else now
        gate = self._gate.get(session, 0.0)
        base = gate if gate > now else now
        self._gate[session] = base + MIN_GAP_S
        return base


# Module-level fallback instance (monkeypatched fresh per test).
_fallback = _FallbackLimiter()


async def _fallback_allow(session: str) -> tuple[bool, str]:
    """Delegate to the in-process fallback; tag a cap reason with ':fb' so logs
    show the block came from the fallback (not Redis). An allow keeps reason ''."""
    allowed, reason = await _fallback.allow(session)
    return (allowed, reason) if allowed else (allowed, f"{reason}:fb")


async def allow_send(redis, session: str) -> tuple[bool, str]:
    """Check the three window counters against their caps.

    Returns (allowed, reason):
      * (False, "<window>-cap") if any Redis fixed window is at/over its cap,
      * (True, "") if every window is under cap,
      * FAIL-SAFE: when `redis` is None OR raises, DELEGATE to the in-process
        fallback limiter (NOT an unconditional allow) so the per-number caps still
        hold during a Redis outage. A fallback block reads "<window>-cap:fb".

    Does NOT mutate any counter — call `record_send` only after a real send.
    """
    if redis is None:
        return await _fallback_allow(session)
    try:
        min_v, hour_v, day_v = await asyncio.gather(
            redis.get(_key(session, "min")),
            redis.get(_key(session, "hour")),
            redis.get(_key(session, "day")),
        )
        min_n = int(min_v) if min_v is not None else 0
        hour_n = int(hour_v) if hour_v is not None else 0
        day_n = int(day_v) if day_v is not None else 0
    except Exception as exc:  # fail-SAFE: fall back to the in-process limiter
        logger.warning("rate_limit.allow_send: redis error (fallback) session=%s err=%s", session, exc)
        return await _fallback_allow(session)

    if min_n >= MAX_PER_MIN:
        return False, "min-cap"
    if hour_n >= MAX_PER_HOUR:
        return False, "hour-cap"
    if day_n >= MAX_PER_DAY:
        return False, "day-cap"
    return True, ""


async def pace(redis, session: str) -> None:
    """Serialize auto-sends on the SAME number to >= MIN_GAP_S apart, + jitter.

    Atomically CLAIMS the next send slot via the Redis Lua gate; when `redis` is
    None or the gate errors, claims from the in-process fallback gate instead so
    pacing survives a Redis outage. Sleeps until the claimed slot (capped by
    _MAX_PACE_WAIT_S) plus a small random jitter, so the inter-send gap is not a
    mechanically-fixed value (a behavioral ban tell). Never raises.
    """
    if redis is None:
        base = await _fallback.claim_pace(session)
    else:
        try:
            base_raw = await redis.eval(
                _GATE_LUA, 1, _key(session, "gate"),
                time.time(), MIN_GAP_S, _GATE_TTL_S,
            )
            base = float(base_raw)
        except Exception as exc:  # fail-safe: claim from the in-process gate
            logger.warning("rate_limit.pace: redis error (fallback gate) session=%s err=%s", session, exc)
            base = await _fallback.claim_pace(session)

    wait = base - time.time()
    if wait > 0:
        await asyncio.sleep(min(wait, _MAX_PACE_WAIT_S) + random.uniform(0, _PACE_JITTER_S))


async def record_send(redis, session: str) -> None:
    """Record a successful auto-send.

    ALWAYS records into the in-process fallback first (cheap, bounded) so the
    fallback caps stay accurate if Redis later fails, then bumps the three Redis
    fixed-window counters in one pipeline (INCR + EXPIRE). FAIL-SAFE: any Redis
    error (or a None handle) leaves the fallback record in place and is otherwise
    ignored (never propagates). Pacing is handled separately by `pace`.
    """
    await _fallback.record(session)
    if redis is None:
        return
    try:
        pipe = redis.pipeline()
        for suffix, ttl in (
            ("min", _WINDOW_MIN_S),
            ("hour", _WINDOW_HOUR_S),
            ("day", _WINDOW_DAY_S),
        ):
            key = _key(session, suffix)
            pipe.incr(key)
            pipe.expire(key, ttl)
        await pipe.execute()
    except Exception as exc:  # fail-safe: never raise from recording
        logger.warning("rate_limit.record_send: redis error (ignored) session=%s err=%s", session, exc)


# ── Per-conversation reply lock ──────────────────────────────────────
# Serializes auto_reply for a single conversation so two CONCURRENT jobs (a double
# webhook event message/message.any, or two messages straddling the debounce
# bucket) can't both slip past the idempotency check and double-reply. Best-effort
# + FAIL-OPEN: a Redis outage must never silence the bot (the post-delay
# idempotency re-check in auto_reply is the backstop). The TTL bounds a crashed job
# so a stale lock self-heals. Sized above a realistic worst-case job: two Claude
# calls (guardrails + generation) that can each retry up to ~30s, + the human-like
# delay + send. The post-delay idempotency re-check is the backstop if it still
# expires mid-job under a degraded LLM API.
_LOCK_TTL_S = 180


def _lock_key(conversation_id: int) -> str:
    """Per-conversation lock key, e.g. agent:rl:lock:42."""
    return f"{_KEY_PREFIX}:lock:{conversation_id}"


async def acquire_conv_lock(redis, conversation_id: int) -> bool:
    """Try to claim the per-conversation reply lock. Returns True to PROCEED
    (acquired, OR redis unavailable → fail-open), False ONLY when another job holds
    it. Never raises."""
    if redis is None:
        return True
    try:
        got = await redis.set(_lock_key(conversation_id), "1", nx=True, ex=_LOCK_TTL_S)
        return bool(got)
    except Exception as exc:  # fail-OPEN: never silence the bot on a redis error
        logger.warning(
            "rate_limit.acquire_conv_lock: redis error (fail-open) conv=%s err=%s",
            conversation_id, exc,
        )
        return True


async def release_conv_lock(redis, conversation_id: int) -> None:
    """Release the per-conversation reply lock. Never raises — a failed release just
    self-heals when the lock's TTL expires."""
    if redis is None:
        return
    try:
        await redis.delete(_lock_key(conversation_id))
    except Exception as exc:  # noqa: BLE001 — a failed release self-heals on TTL
        logger.warning(
            "rate_limit.release_conv_lock: redis error (ignored) conv=%s err=%s",
            conversation_id, exc,
        )
