"""Follow-up of ABANDONED QUOTES — one warm re-engagement nudge.

When, on an AUTO-mode number, Sara quoted a concrete price/offer and the client
then went silent for ~30-45 min, send ONE warm free-text nudge (the LLM writes
it) to softly re-open the chat. HARD RULES:
  * MAX 1 follow-up per conversation EVER (atomic claim on agent_followup_at).
  * ONLY if a concrete price/offer was given (has_price on the last agent body).
  * NEVER if a human took over (paused_human) or it is paused_risk.
  * ONLY within the 12:00-05:00 Europe/Madrid window (in_followup_window).
  * Auto send → MUST go through the anti-ban gate + pace + record_send.

ARCHITECTURE (CLAUDE.md rule 6 — never asyncio.sleep >1s in a CRON job):
  * followup_sweep_job (CRON, ~every 10 min) ONLY finds candidates + enqueues —
    no sends, no LLM, no sleeps. It returns immediately when out of window.
  * followup_send_job (NORMAL arq job) does the per-conversation TOCTOU re-check,
    generation, anti-ban, atomic claim, humanize delay and send. Bounded sleeps
    are allowed here (it is not the cron loop), exactly like auto_reply_job.

The ~30-45 min gap is achieved by the sweep SCANNING for conversations whose
last agent price message is in the silence window — NOT by sleeping that long.
"""
from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime
from datetime import time as dtime

import asyncpg

from app import queries
from app.agent import rate_limit, reply_engine
from app.agent.auto_reply import _humanize_typing_seconds, _send_and_persist
from app.agent.rate_limit import _MADRID
from app.waha_client import WahaClient

logger = logging.getLogger("agent.followup")

# ── Tunables (no magic numbers) ──────────────────────────────────────
# Silence window: the last agent quote must be at least this old (client went
# quiet) but not older than the max (stale leads are not worth a nudge).
_MIN_SILENCE_MIN = 30
_MAX_SILENCE_MIN = 45
# Send-time staleness backstop. The silence upper bound is enforced only at sweep
# time; a backed-up queue could otherwise run the send job much later and nudge an
# hours-old quote. Skip at send time if the quote is staler than this (2x the
# sweep max) — lenient enough to still send slightly-delayed jobs, strict enough
# to never nudge an ancient "abandoned" quote.
_MAX_SEND_AGE_MIN = _MAX_SILENCE_MIN * 2
# Cap on candidates enqueued per sweep tick — keeps the cron cheap + bounds the
# per-tick send fan-out (each enqueues one normal job).
_SWEEP_MAX_CANDIDATES = 20
# Allowed send window in Europe/Madrid wall-clock time: [12:00, 05:00) — wraps
# past midnight (12:00→05:00 next day). Inverse-ish of quiet hours; the casas'
# best re-engagement hours. Pure constants so in_followup_window stays testable.
_WINDOW_START = dtime(hour=12, minute=0)
_WINDOW_END = dtime(hour=5, minute=0)

# Concrete-euro-amount detector. Conservative: only fires when the agent message
# actually quoted a price, so a nudge is never sent on a chat that never had an
# offer. Matches "120€", "120 €", "€120", "€ 120" and "120 euros" / "120 euro".
_PRICE_RE = re.compile(
    r"(?:\d{2,4}\s*€)"          # 120€ / 120 €
    r"|(?:€\s*\d{1,4})"          # €120 / € 120
    r"|(?:\b\d{2,4}\s*euros?\b)",  # 120 euros / 120 euro
    re.IGNORECASE,
)


def has_price(text: str | None) -> bool:
    """True if `text` quotes a concrete euro amount (price/offer was given).

    Pure + conservative: requires an explicit € symbol or the word "euro(s)" next
    to a 1-4 digit number, so a bare number ("a las 22") never counts as a price.
    """
    if not text:
        return False
    return _PRICE_RE.search(text) is not None


def in_followup_window(now_local: datetime | None = None) -> bool:
    """True if `now_local` (Europe/Madrid) is inside the 12:00-05:00 window.

    Pure + testable (pass an aware datetime; defaults to now in Madrid). The
    window wraps past midnight, so it uses the same wrap-aware comparison as
    rate_limit.in_quiet_hours: with start(12:00) > end(05:00), the slot is
    `current >= 12:00 OR current < 05:00`. End is exclusive (05:00 sharp is out).
    """
    now = now_local or datetime.now(_MADRID)
    current = now.timetz() if now.tzinfo else now.time()
    current = dtime(hour=current.hour, minute=current.minute)
    # 12:00 > 05:00 → wrap-past-midnight branch (mirrors in_quiet_hours).
    return current >= _WINDOW_START or current < _WINDOW_END


async def followup_sweep_job(ctx: dict) -> None:
    """CRON (≈ every 10 min): find abandoned-quote candidates + enqueue ONE
    per-conversation send job each. Cheap + non-blocking: NO sends, NO LLM, NO
    sleeps (CLAUDE.md rule 6). Returns immediately when out of the send window.

    Enqueues via the worker's ArqRedis handle (ctx["arq"]); a plain redis client
    has no enqueue_job, so startup stores a real ArqRedis (mirrors deps.py).
    Wrapped so a sweep failure never tumbles the cron loop.
    """
    if not in_followup_window():
        return

    kpi: asyncpg.Pool = ctx["kpi_db"]
    arq = ctx.get("arq")
    if arq is None:
        logger.warning("followup_sweep: no arq handle in ctx — cannot enqueue")
        return

    try:
        candidates = await queries.list_followup_candidates(
            kpi,
            min_silence_min=_MIN_SILENCE_MIN,
            max_silence_min=_MAX_SILENCE_MIN,
            limit=_SWEEP_MAX_CANDIDATES,
        )
    except Exception:
        logger.exception("followup_sweep: candidate query failed")
        return

    for cand in candidates:
        try:
            # _job_id dedups concurrent ticks for the SAME conversation into one
            # queued send job (the atomic claim is the final race guard anyway).
            await arq.enqueue_job(
                "followup_send_job",
                cand.conversation_id,
                _job_id=f"followup:{cand.conversation_id}",
            )
        except Exception:
            logger.exception(
                "followup_sweep: enqueue failed conv=%s", cand.conversation_id
            )
    logger.info("followup_sweep: enqueued %d candidate(s)", len(candidates))


async def followup_send_job(ctx: dict, conversation_id: int) -> None:
    """NORMAL arq job: send ONE abandoned-quote follow-up for a conversation.

    Guard order (each step skips WITHOUT claiming on failure, so a skip never
    burns the one allowed touch):
      (i)   TOCTOU re-check: reload mode (still 'auto'), agent_status (active),
            agent_followup_at still NULL, and the LAST message is STILL Sara's
            quote (out + agent_generated, no newer inbound) AND has_price(body).
      (ii)  re-check in_followup_window (the window may have closed since sweep).
      (iii) generate_followup_text — "" → SKIP (never send a generic nudge).
      (iv)  anti-ban: allow_send gate (skip if denied) → pace.
      (v)   ATOMIC CLAIM claim_followup — False → another job won → SKIP.
      (vi)  humanize delay → _send_and_persist (agent_generated=TRUE) →
            record_send.

    The claim sits AFTER guards/generation (so skips don't burn the touch) but
    BEFORE the WAHA send (so a crash mid-send still consumes the touch — never a
    duplicate nudge). NEVER raises out of the job (wrapped + logged).
    """
    try:
        await _followup_send_impl(ctx, conversation_id)
    except Exception:
        logger.exception("followup_send: unexpected error conv=%s", conversation_id)


async def _followup_send_impl(ctx: dict, conversation_id: int) -> None:
    kpi: asyncpg.Pool = ctx["kpi_db"]

    # (i) TOCTOU guards — never trust the sweep snapshot.
    mode = await queries.get_wa_mode_for_conversation(kpi, conversation_id)
    if mode != "auto":  # follow-up is auto-only (reject off AND copilot)
        logger.info("followup_send: skip (mode=%s) conv=%s", mode, conversation_id)
        return
    status_ = await queries.get_conversation_agent_status(kpi, conversation_id)
    if status_ is not None and status_ != "active":  # paused_human / paused_risk
        logger.info(
            "followup_send: skip (status=%s) conv=%s", status_, conversation_id
        )
        return

    detail = await queries.get_conversation_detail(kpi, conversation_id)
    if not detail:
        logger.warning("followup_send: conversation %s not found — skip", conversation_id)
        return

    # Re-verify the conversation is STILL an abandoned quote: the last message is
    # Sara's agent send (out + agent_generated, no newer inbound) and it quoted a
    # price. If the client replied after the quote, the last message is now their
    # inbound → not a candidate → skip (and do NOT claim).
    last = await _last_message(kpi, conversation_id)
    if last is None:
        return
    if not (last["direction"] == "out" and last["agent_generated"]):
        logger.info("followup_send: skip (client replied / not last) conv=%s", conversation_id)
        return
    if not has_price(last["body"]):
        logger.info("followup_send: skip (no price in last quote) conv=%s", conversation_id)
        return
    # Send-time staleness backstop — never nudge an hours-old quote if the send
    # job ran much later than the sweep enqueued it (queue backlog). Fail-open:
    # if age_min is missing/NULL, the secondary backstop is skipped (the sweep
    # window already bounded the candidate at enqueue time).
    age_min = last.get("age_min")
    if age_min is not None and age_min > _MAX_SEND_AGE_MIN:
        logger.info(
            "followup_send: skip (quote stale %.0f min) conv=%s", age_min, conversation_id
        )
        return

    # Belt-and-suspenders: the marker may have been claimed by a prior job since
    # the sweep. The atomic claim below is the real guard; this is a cheap early
    # skip that avoids burning an LLM call.
    if await queries.get_followup_at(kpi, conversation_id) is not None:
        logger.info("followup_send: skip (already followed up) conv=%s", conversation_id)
        return

    # (ii) Window may have closed between the sweep and now → skip.
    if not in_followup_window():
        logger.info("followup_send: skip (window closed) conv=%s", conversation_id)
        return

    # (iii) Generate the nudge. Returns "" on any failure/empty/leak → SKIP the
    # send (never send a generic fallback). Never raises.
    reply = await reply_engine.generate_followup_text(
        kpi,
        casa_id=detail.casa_id,
        conv_id=conversation_id,
        lang=None,
        client_name=detail.contact_name or "",
    )
    if not reply:
        logger.info("followup_send: skip (empty generation) conv=%s", conversation_id)
        return

    waha: WahaClient = ctx["waha"]
    redis = ctx.get("redis")  # may be None → in-process fallback limiter (fail-safe)
    session, chat = detail.waha_session, detail.contact_jid

    # (iv) ANTI-BAN gate — caps aggregate outbound per number. FAIL-SAFE: when
    # redis is None/erroring, allow_send/pace use an in-process fallback limiter
    # so the per-number caps still hold during a Redis outage.
    allowed, reason = await rate_limit.allow_send(redis, session)
    if not allowed:
        logger.info(
            "followup_send: rate-limited conv=%s session=%s reason=%s",
            conversation_id, session, reason,
        )
        return
    await rate_limit.pace(redis, session)

    # (v) ATOMIC CLAIM — flips agent_followup_at NULL→now() iff still NULL. False
    # means another job already claimed (won the race) → SKIP, no send. Placed
    # AFTER guards/generation (a skip never burns the touch) but BEFORE the WAHA
    # send (a crash mid-send still consumes the one allowed touch → no duplicate).
    if not await queries.claim_followup(kpi, conversation_id):
        logger.info("followup_send: skip (claim lost — already followed up) conv=%s", conversation_id)
        return

    # (vi) Humanize delay (bounded, allowed in a normal job) then send + persist
    # as agent_generated=TRUE (so the nudge isn't misread as a human takeover next
    # turn), then record the send against the per-number caps.
    await asyncio.sleep(_humanize_typing_seconds(len(reply)))
    await _send_and_persist(kpi, waha, conversation_id, session, chat, reply)
    await rate_limit.record_send(redis, session)
    logger.info("followup_send: sent conv=%s len=%s", conversation_id, len(reply))


async def _last_message(kpi: asyncpg.Pool, conversation_id: int) -> dict | None:
    """The conversation's single most-recent message (direction, agent_generated,
    body, age_min) or None when empty. Used by the TOCTOU re-check to confirm the
    last turn is STILL Sara's quote with no newer inbound, and to enforce the
    send-time staleness backstop. Parametrized; backed by
    ix_message_conv_created_desc."""
    async with kpi.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT direction, agent_generated, body,
                   extract(epoch FROM (now() - created_at)) / 60.0 AS age_min
            FROM message
            WHERE conversation_id = $1
            ORDER BY created_at DESC
            LIMIT 1
            """,
            conversation_id,
        )
    return dict(row) if row else None
