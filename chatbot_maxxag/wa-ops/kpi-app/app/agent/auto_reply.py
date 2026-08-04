"""auto_reply_job — the F2 worker that turns the F1 reply engine into a send.

Enqueued (never executed) by the WAHA webhook after a new incoming message is
persisted. This job is the ONLY place that decides whether to reply and actually
talks to WAHA. It re-loads mode + pause state from the DB on every run (it never
trusts the webhook), runs the safety guardrails, applies a bounded human-like
delay, then either sends (mode=auto) or stores a suggestion (mode=copilot).

Why the bounded asyncio.sleep here is allowed: CLAUDE.md rule 6 / "No hacer"
forbid long sleeps in the CRON job (they block the 1-call-per-tick health loop).
This is a normal arq job (like analyze_conversations_bulk_job, which also sleeps
deliberately), runs under WorkerSettings.max_jobs concurrency with a 900s
job_timeout, so a sub-15s humanize delay is well within budget.

Guardrails reuse the existing analyzer skills (detect_red_flags +
evaluate_escalation) inside skills.token_accumulator() to scope token counting,
and both run with return_exceptions=True (CLAUDE.md rule 7) so one failing skill
never tumbles the other or the reply.
"""
from __future__ import annotations

import asyncio
import logging
import random
import re
import uuid
from datetime import datetime

import asyncpg

from app import queries
from app.agent import outcall, persona, photo_select, rate_limit, reply_engine
from app.analyzer import skills
from app.analyzer.skills import Message
from app.settings import get_settings
from app.waha_client import WahaClient
from app.waha_msgid import extract_waha_msg_id

logger = logging.getLogger("agent.auto_reply")


# ── Encargada heads-up (WhatsApp) ────────────────────────────────────
# Minimum digits for a plausible international phone number → WA chat id.
_MIN_PHONE_DIGITS = 8


def _phone_to_chat_id(raw: str | None) -> str | None:
    """Normalize a stored recepción phone ('+34 603 201 414') to a WA chat id
    ('34603201414@c.us'). None when there aren't enough digits (unset/garbage)."""
    digits = "".join(ch for ch in (raw or "") if ch.isdigit())
    return f"{digits}@c.us" if len(digits) >= _MIN_PHONE_DIGITS else None


def _conversation_link(conversation_id: int) -> str:
    """Dashboard deep-link to the conversation for the encargada's heads-up. ""
    when DOMAIN is unset (the heads-up still sends, just without a link)."""
    try:
        domain = get_settings().domain
    except Exception:  # noqa: BLE001 — settings must never break a notify
        domain = ""
    return f"https://{domain}/conversation/{conversation_id}" if domain else ""


def _detect_girl_request(text: str, girl_names: list[str]) -> str | None:
    """Return the girl NAME the client named in `text`, or None. Whole-word,
    case-insensitive; skips very short names (<3) to avoid false positives."""
    if not text:
        return None
    low = text.lower()
    for name in girl_names:
        n = (name or "").strip().lower()
        if len(n) < 3:
            continue
        if re.search(rf"\b{re.escape(n)}\b", low):
            return name
    return None


# Heuristic time/'now' expressions (es) → the client is proposing an hour. Used
# ONLY in manual mode to ping the encargada to confirm that slot. Over/under-firing
# is fine: it's a deduped heads-up, not a hard action.
_TIME_RE = re.compile(
    r"\b(?:a|sobre|para)?\s*las?\s*\d{1,2}"                 # "a las 10", "las 22"
    r"|\b\d{1,2}\s*(?::\d{2}|\s*h\b|\s*hs\b|\s*pm\b|\s*am\b)"  # "22:00", "10h", "10 pm"
    r"|\b(?:ahora|ahorita|esta\s+noche|esta\s+tarde|al\s+mediod[ií]a|"
    r"en\s+(?:un|media)\s+(?:rato|hora))\b",
    re.IGNORECASE,
)


def _detect_time_request(text: str) -> bool:
    """True when the client mentions a concrete time or 'now' (a booking hour is
    forming). Manual-mode only: triggers the encargada heads-up to confirm the slot
    while Sara holds with 'dame un momento…'."""
    return bool(text) and bool(_TIME_RE.search(text))


# Explicit "book me / reserve" intent from the client (es-first, light en/fr/it).
# One of the "datos concretos" signals (with time/girl) that a booking is CLOSING.
_BOOKING_RE = re.compile(
    r"\bres[eé]rv\w*"        # es: reserva/reservar/resérvame/reservada/reservo…
    r"|\bbook(?:ing|ed)?\b"  # en: book/booking/booked
    r"|\br[eé]serv\w*"       # fr: réserver/réservation
    r"|\bprenot\w*",         # it: prenota/prenotare/prenotazione
    re.IGNORECASE,
)


def _detect_booking_intent(text: str) -> bool:
    """True when the client EXPLICITLY asks to book/reserve ('resérvame', 'quiero
    reservar'…) — one of the concrete-data signals (with time/girl) that a booking
    is closing → the central reception heads-up."""
    return bool(text) and bool(_BOOKING_RE.search(text))


async def _notify_encargada(
    ctx: dict, kpi: asyncpg.Pool, detail, conversation_id: int, *, tag: str, text: str
) -> None:
    """Ping the casa's encargada ONCE per conversation for `tag`: send a WhatsApp
    from the casa session to casa_profile.whatsapp_recepcion AND record a panel
    alert. Fully FAIL-SOFT — never breaks the reply.

    The dedup alert is written only AFTER a successful send (or when there's no
    number to send to), so a transient WAHA error retries on the next trigger
    instead of being silently marked done. The WA goes through the SAME anti-ban
    contract (pace + record_send) as the client reply so this internal heads-up
    counts toward the per-number caps and doesn't burst on the business number."""
    try:
        # This has_open_alert → send → insert_alert sequence is race-free because the
        # per-conversation lock (rate_limit.acquire_conv_lock) serializes jobs for one
        # conversation. Under a Redis outage the lock is fail-open (CLAUDE.md invariant
        # — never silence the bot), so in that degraded window two concurrent jobs
        # could duplicate this heads-up: an ACCEPTED trade-off (same as the reply
        # path), not worth a per-job Postgres advisory lock to fully close.
        if await queries.has_open_alert(kpi, conversation_id, tag):
            return
        chat_id = _phone_to_chat_id(await queries.get_casa_recepcion(kpi, detail.casa_id))
        waha = ctx.get("waha")
        if chat_id is None or waha is None:
            # No WhatsApp target → record the panel alert (deduped) and stop.
            await queries.insert_alert(
                kpi, type=tag, severity="info",
                conversation_id=conversation_id, inbox_id=detail.casa_id, message=text,
            )
            logger.info(
                "notify_encargada: no recepcion/waha casa=%s tag=%s (panel only)",
                detail.casa_id, tag,
            )
            return
        redis = ctx.get("redis")
        await rate_limit.pace(redis, detail.waha_session)
        link = _conversation_link(conversation_id)
        body = f"🔔 {text}" + (f"\n{link}" if link else "")
        await waha.send_text(detail.waha_session, chat_id, body)
        await rate_limit.record_send(redis, detail.waha_session)
        # Dedup + panel record only AFTER the send succeeded (a raise skips this →
        # retried next trigger).
        await queries.insert_alert(
            kpi, type=tag, severity="info",
            conversation_id=conversation_id, inbox_id=detail.casa_id, message=text,
        )
        logger.info(
            "notify_encargada: WA sent casa=%s tag=%s conv=%s",
            detail.casa_id, tag, conversation_id,
        )
    except Exception:  # noqa: BLE001 — notifying the encargada must never break the reply
        logger.warning("notify_encargada failed conv=%s tag=%s", conversation_id, tag)

# ── Tunables (no magic numbers) ──────────────────────────────────────
# Recent human outbound within this window → pause as paused_human.
_HUMAN_PAUSE_WINDOW_MIN = 30
# Random "saw your message" read pause (seconds), min/max.
_READ_DELAY_S: tuple[float, float] = (1.5, 3.5)
# Typing time grows with reply length; this is the per-character factor.
_PER_CHAR_TYPING_S = 0.04
# Hard cap on the TOTAL humanize delay (this is a job, not the cron loop).
_MAX_HUMANIZE_DELAY_S = 14.0
# Escalation severities that pause the agent for human review.
_ESCALATION_BLOCK = ("medium", "high")
# Red-flag types that pause the agent. 'menor'/'fraude' are the hard-stop
# safety flags (minor / fraud). 'acoso' (harassment) is also a discrete type in
# the current skill taxonomy, so it is included; 'insulto'/'timewaster' are NOT
# (those are quality signals, not safety stops).
_RED_FLAG_BLOCK = ("menor", "fraude", "acoso")
# Copilot suggestion alerts cap the stored reply length defensively.
_SUGGESTION_MAXLEN = 1000
# Photo cards are persisted with this MIME (WAHA re-encodes to jpeg on send).
_PHOTO_MIME = "image/jpeg"
# Envío de tarjetas de foto: OFF — las chicas ya están en la web, Sara pasa el
# enlace en vez de mandar fotos. Poner True para reactivar el envío de fotos.
_PHOTO_CARDS_ENABLED = False
# Auto-protección: si Sara dispara este nº de pausas-riesgo en el MISMO número
# dentro de la ventana, el número pasa a manual (mode=off) + alerta al admin.
_SARA_FLOOD_THRESHOLD = 3
_SARA_FLOOD_WINDOW_MIN = 30
# A/B greeting test: OFF — keep Sara's opener consistent (one behavior) so she's
# predictable to tune. Flip to True to re-enable the 3-variant greeting test.
_AB_GREETING_ENABLED = False
# Split a reply into up to 2 "bubbles" only when it's longer than this (chars).
# Short replies (the common case with the current persona) stay a single bubble.
_BUBBLE_SPLIT_MIN = 140
# Human-like pause (seconds) between the 1st and 2nd bubble.
_BUBBLE_GAP_S: tuple[float, float] = (1.0, 2.5)
# Sentence boundary for bubble splitting: '.', '?' or '!' NOT preceded by a dot
# (so '...' is never a split point) followed by whitespace, OR a newline.
_BUBBLE_BOUNDARY_RE = re.compile(r"(?<![.])[.?!]\s+|\n+")


def _split_reply(text: str) -> list[str]:
    """Split a reply into 1 or 2 bubbles at the sentence boundary closest to the
    middle. Returns a single-item list when the reply is short or has no clean
    boundary (never splits mid-word, never on '...'). Pure + side-effect free."""
    text = (text or "").strip()
    if not text:
        return []
    if len(text) <= _BUBBLE_SPLIT_MIN:
        return [text]
    mid = len(text) / 2
    best: int | None = None
    for m in _BUBBLE_BOUNDARY_RE.finditer(text):
        pos = m.end()
        if pos <= 0 or pos >= len(text):
            continue
        if best is None or abs(pos - mid) < abs(best - mid):
            best = pos
    if best is None:
        return [text]
    first, second = text[:best].strip(), text[best:].strip()
    if not first or not second:
        return [text]
    return [first, second]


def _should_block(flags: object, escalation: object) -> tuple[bool, str]:
    """Pure guardrail decision over the (possibly Exception) skill results.

    Returns (block, reason). A skill that raised is treated as non-blocking for
    its own signal (fail-open per signal, but the other signal still applies) —
    we never block on an inability to evaluate, and we never reply when either
    real signal fires.
    """
    real_flag = False
    if not isinstance(flags, Exception):
        real_flag = any(
            getattr(f, "type", None) in _RED_FLAG_BLOCK for f in (flags or [])
        )
    escalate = (
        not isinstance(escalation, Exception)
        and getattr(escalation, "should_escalate", False)
        and getattr(escalation, "severity", None) in _ESCALATION_BLOCK
    )
    if real_flag:
        return True, "red_flag"
    if escalate:
        return True, f"escalation:{getattr(escalation, 'severity', '?')}"
    return False, ""


def _humanize_typing_seconds(reply_len: int) -> float:
    """Bounded typing duration proportional to reply length.

    Total delay (read + typing) is capped at _MAX_HUMANIZE_DELAY_S; the typing
    slice leaves room for the worst-case read pause so the cap always holds.
    """
    typing = reply_len * _PER_CHAR_TYPING_S
    budget = _MAX_HUMANIZE_DELAY_S - _READ_DELAY_S[1]
    return max(min(typing, budget), 0.0)


async def _load_msgs(kpi: asyncpg.Pool, conversation_id: int) -> list[Message]:
    """Fetch the conversation transcript exactly like analyze_conversation_job
    (chronological, role-mapped, body-capped) for the guardrail skills."""
    async with kpi.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT body, direction, extract(epoch from created_at)::int AS ts
            FROM message
            WHERE conversation_id = $1
            ORDER BY created_at ASC
            """,
            conversation_id,
        )
    return [
        Message(
            ts=r["ts"],
            role="cliente" if r["direction"] == "in" else "mamai",
            content=(r["body"] or "")[:1000],
        )
        for r in rows
    ]


async def _compute_outcall_context(
    kpi: asyncpg.Pool, conversation_id: int, casa_id: int, casa_name: str | None
) -> tuple[int | None, int | None, int | None, bool]:
    """Deterministically decide the outcall pricing CONTEXT for this turn.

    Returns (outcall_base_eur, outcall_taxi_low, outcall_taxi_high, outcall_defer):
      * (base, low, high, False) — the client sent a location PIN AND the casa is
        geocoded with a known city + outcall base, so the price is computed in
        Python (Sara quotes "domicilio {base}€ + el taxi, suele rondar {low}-{high}€").
      * (None, None, None, True)  — the client sent a PIN but the price is NOT
        computable (no casa coords / unknown city / no outcall base) → Sara defers.
      * (None, None, None, False) — no location PIN → no outcall context (the
        persona's static rule already handles asking for the pin when wanted).

    Pure-ish (only reads): the price is computed by the pure `outcall` module; the
    LLM never does the arithmetic. Fully fail-soft — on error it DEFERS when a PIN
    was already received (so Sara never ignores the pin) and otherwise returns
    (None, None, False), so a pricing failure never changes the normal reply.
    """
    client_coords: tuple[float, float] | None = None
    try:
        client_coords = await queries.get_latest_incoming_location(kpi, conversation_id)
        if client_coords is None:
            return (None, None, None, False)  # no PIN → no outcall context

        # The client sent a PIN: from here we either price it or DEFER (never
        # silently drop back to a normal reply, so Sara doesn't ignore the pin).
        knowledge = await queries.get_casa_knowledge(kpi, casa_id)
        profile = knowledge.profile
        if profile is None:
            return (None, None, None, True)

        casa_coords = (
            (profile.address_lat, profile.address_lng)
            if profile.address_lat is not None and profile.address_lng is not None
            else None
        )
        city = outcall.city_for_casa_name(casa_name)
        # Base salida: manual override (casa outcall.base_price_eur) wins; else the
        # price parsed from the synced web rates ("a hotel/domicilio"). None when
        # neither exists (e.g. the web says "consultar") → estimate defers.
        base_eur = queries.get_outcall_base_eur(profile.outcall) or outcall.outcall_base_from_rates(
            profile.rates
        )
        buffer = queries.get_outcall_taxi_buffer(profile.outcall)

        estimate = outcall.estimate_outcall(
            casa_coords=casa_coords,
            client_coords=client_coords,
            city=city,
            outcall_base_eur=base_eur,
            now_local=datetime.now(rate_limit._MADRID),
            taxi_buffer=buffer,
        )
        if estimate is None:
            return (None, None, None, True)  # PIN received but not computable → defer
        return (estimate.base_eur, estimate.taxi_low_eur, estimate.taxi_high_eur, False)
    except Exception:  # pricing must never break the reply
        logger.warning(
            "auto_reply: outcall context build failed conv=%s", conversation_id
        )
        # If a PIN was already retrieved, DEFER (don't silently ignore the pin);
        # if the PIN lookup itself failed, there is no outcall context.
        return (
            (None, None, None, True)
            if client_coords is not None
            else (None, None, None, False)
        )


async def auto_reply_job(ctx: dict, conversation_id: int) -> None:
    """Generate and (in auto mode) send a single agent reply for a conversation.

    Thin wrapper: takes a per-conversation Redis lock so only ONE reply job runs at
    a time for a conversation — a double webhook event (message/message.any) or two
    messages straddling the debounce bucket can't both slip past the idempotency
    check and double-reply. FAIL-OPEN: a redis outage → proceed (the post-delay
    idempotency re-check inside is the backstop). The lock is released in finally.
    """
    kpi: asyncpg.Pool = ctx["kpi_db"]
    redis = ctx.get("redis")
    if not await rate_limit.acquire_conv_lock(redis, conversation_id):
        logger.info(
            "auto_reply: conv lock held by another job — skip conv=%s", conversation_id
        )
        return
    try:
        await _auto_reply_locked(ctx, kpi, conversation_id)
    finally:
        await rate_limit.release_conv_lock(redis, conversation_id)


async def _auto_reply_locked(ctx: dict, kpi: asyncpg.Pool, conversation_id: int) -> None:
    """The reply pipeline, run while holding the per-conversation lock.

    Steps: (a) re-load mode + pause state and bail; (b) guardrails →
    paused_risk; (c) recent-human-outbound → paused_human; (d) generate reply;
    (e) bounded human-like delay; (f) send (auto) or store suggestion (copilot).
    """
    # (a) Re-load mode + status inside the worker (never trust the webhook —
    # a human may have taken over between enqueue and execution).
    mode = await queries.get_wa_mode_for_conversation(kpi, conversation_id)
    if mode == "off":
        return
    status_ = await queries.get_conversation_agent_status(kpi, conversation_id)
    if status_ is not None and status_ != "active":  # paused_* stays paused
        return

    # IDEMPOTENCIA (anti-duplicado): si Sara YA respondió al último turno — el
    # mensaje más reciente ya es un saliente generado por ella —, NO vuelvas a
    # contestar. Mata el mensaje duplicado venga de un reintento de arq o del doble
    # evento message/message.any de WAHA. (Un humano tomando el relevo se maneja
    # aparte con has_recent_human_outbound / paused_human.)
    if await queries.last_out_is_agent_generated(kpi, conversation_id):
        logger.info(
            "auto_reply: ya respondido al último turno — skip conv=%s", conversation_id
        )
        return

    detail = await queries.get_conversation_detail(kpi, conversation_id)
    if not detail:
        logger.warning("auto_reply: conversation %s not found — skip", conversation_id)
        return

    msgs = await _load_msgs(kpi, conversation_id)
    if not msgs:
        return

    # (b) Guardrails — reuse the analyzer skills, cost captured, fault isolated.
    with skills.token_accumulator():
        flags, escalation = await asyncio.gather(
            skills.detect_red_flags(msgs),
            skills.evaluate_escalation(msgs),
            return_exceptions=True,
        )
    block, reason = _should_block(flags, escalation)
    if block:
        await queries.set_conversation_agent_status(kpi, conversation_id, "paused_risk")
        await queries.insert_alert(
            kpi,
            type="paused_risk",
            severity="critical",
            conversation_id=conversation_id,
            inbox_id=detail.casa_id,
            message=(
                f"Agente IA pausado por seguridad ({reason}). "
                "Revisión humana requerida."
            ),
        )
        logger.info("auto_reply: paused_risk conv=%s reason=%s", conversation_id, reason)
        # AUTO-PROTECCIÓN: un exceso de pausas-riesgo en el mismo número en poco
        # tiempo = Sara descontrolada → pasa el número a MANUAL (off) + avisa al
        # admin. Best-effort: nunca debe tumbar el job.
        try:
            wa_id, risk_cnt = await queries.count_risk_pauses_on_number(
                kpi, conversation_id, window_min=_SARA_FLOOD_WINDOW_MIN
            )
            if wa_id and risk_cnt >= _SARA_FLOOD_THRESHOLD:
                # Flip a 'off' SOLO si no lo estaba ya → la alerta se emite una
                # única vez aunque corran varios jobs del mismo número a la vez.
                flipped = await queries.disable_wa_number_if_active(kpi, wa_id)
                if flipped:
                    await queries.insert_alert(
                        kpi,
                        type="sara_misbehaving",
                        severity="critical",
                        inbox_id=detail.casa_id,
                        message=(
                            f"Sara pausada por riesgo en {risk_cnt} conversaciones en "
                            f"{_SARA_FLOOD_WINDOW_MIN} min ({detail.waha_session}). "
                            "Número pasado a MANUAL automáticamente — requiere revisión."
                        ),
                    )
                    logger.warning(
                        "auto_reply: AUTO-PROTECT wa_number=%s risk_count=%s → mode=off",
                        wa_id, risk_cnt,
                    )
                    from app.notify import push_alert
                    await push_alert(
                        f"🚨 Sara pausada (auto-protección): {risk_cnt} pausas-riesgo en "
                        f"{_SARA_FLOOD_WINDOW_MIN} min en {detail.waha_session}. "
                        "Número pasado a MANUAL — requiere revisión."
                    )
        except Exception:  # noqa: BLE001 — la auto-protección nunca tumba el job
            logger.exception("auto_reply: auto-protect check failed (non-fatal)")
        return  # DO NOT reply

    # (c) Human-pause check — a receptionist replied recently → hand off.
    if await queries.has_recent_human_outbound(
        kpi, conversation_id, _HUMAN_PAUSE_WINDOW_MIN
    ):
        await queries.set_conversation_agent_status(kpi, conversation_id, "paused_human")
        logger.info("auto_reply: paused_human conv=%s", conversation_id)
        return

    # (c.2) ANTI-BAN gate — caps the AGGREGATE outbound rate PER NUMBER
    # (waha_session), the main remaining ban vector once per-conversation
    # debounce + human-like delays are in place. ONLY the auto path is gated:
    # copilot never sends (no ban risk), so it falls through to generate_reply
    # below and stores a suggestion as before. Gating here — before the Claude
    # call — also avoids wasting an LLM call on a send we would then block.
    # FAIL-SAFE: in_quiet_hours returns False on bad config; allow_send delegates
    # to an in-process fallback limiter when redis is None/erroring, so the per-
    # number caps STILL hold during a Redis outage (the bot is never left
    # un-throttled — the primary ban vector). Returns (True, "") under cap.
    if mode == "auto":
        redis = ctx.get("redis")
        if rate_limit.in_quiet_hours():
            logger.info("auto_reply: skip (quiet hours) conv=%s", conversation_id)
            return
        allowed, reason = await rate_limit.allow_send(redis, detail.waha_session)
        if not allowed:
            logger.info(
                "auto_reply: rate-limited conv=%s session=%s reason=%s",
                conversation_id, detail.waha_session, reason,
            )
            return

    # (c.3) F3 OUTCALL: if the client just sent a location PIN, compute the outcall
    # price in PYTHON (never the model) and pass it as context. Computed here —
    # after the guards/rate gate — so a blocked/paused conv never runs the math.
    # Fully fail-soft: (None, False) on any issue → the normal reply is unchanged.
    outcall_base, outcall_taxi_low, outcall_taxi_high, outcall_defer = (
        await _compute_outcall_context(
            kpi, conversation_id, detail.casa_id, detail.casa_name
        )
    )

    # (c.4) OUTCALL HANDOFF: a location pin for an outcall is the clearest "client
    # is closing a salida" signal — and for a salida the casa asks the client's
    # location in real time, so the team takes the final steps. Ping the encargada
    # (WhatsApp + panel alert, once per conversation). Sara keeps replying; this is a
    # heads-up, NOT a pause, and it fires in auto AND copilot.
    if outcall_base is not None or outcall_defer:
        await _notify_encargada(
            ctx, kpi, detail, conversation_id,
            tag="outcall_handoff",
            text=(
                "Cliente cerrando salida — pedir ubicación en tiempo real y cobro "
                "(taxi por adelantado por Bizum: 100% mejor, si no 30% + resto efectivo)"
            ),
        )

    # (d) Generate the reply. generate_reply never raises (returns a localized
    # fallback line on any failure), so no try/except is needed here. lang=None
    # lets the engine resolve the casa's default_lang.
    last_incoming = next((m.content for m in reversed(msgs) if m.role == "cliente"), "")

    # (c.5) RECEPCIÓN HEADS-UP (once per conversation, fail-soft): exactly ONE ping
    # per message, chosen by precedence so recepción is never double-pinged —
    #  · CONCRETE CLOSE (a proposed TIME or an explicit "resérvame") → booking_close,
    #    the "atiéndele para cerrar" framing, enriched with the girl/hour context. It
    #    SUPERSEDES the verify heads-up, so a real close always reaches recepción with
    #    the close framing (a prior-turn girl_request never swallows it: booking_close
    #    has its own once-per-conversation dedup tag).
    #  · else, WEB-sync casa + a bare girl NAME (browsing) → girl_request so the
    #    encargada verifies real-time availability. A MANUAL (Backoffice) casa trusts
    #    its roster, so a bare name is not pinged.
    try:
        _manual_casa = await queries.get_casa_manual_mode(kpi, detail.casa_id)
    except Exception:  # noqa: BLE001 — fail-soft → behave as web mode
        _manual_casa = False
    try:
        _girl_names = await queries.get_active_girl_names(kpi, detail.casa_id)
    except Exception:  # noqa: BLE001 — fail-soft → no girl-name detection
        _girl_names = []
    _named_girl = _detect_girl_request(last_incoming, _girl_names)
    _time_req = _detect_time_request(last_incoming)
    _concrete_close = _time_req or _detect_booking_intent(last_incoming)
    try:
        if _concrete_close:
            if _named_girl and _time_req:
                _detalle = f"pide a {_named_girl} y propone hora"
            elif _named_girl:
                _detalle = f"pide a {_named_girl}"
            elif _time_req:
                _detalle = "propone una hora"
            else:
                _detalle = "quiere reservar"
            await _notify_encargada(
                ctx, kpi, detail, conversation_id, tag="booking_close",
                text=f"Cliente cerrando reserva ({_detalle}) — atiéndele para cerrar",
            )
        elif _named_girl and not _manual_casa:
            await _notify_encargada(
                ctx, kpi, detail, conversation_id, tag="girl_request",
                text=f"Cliente pregunta por {_named_girl} — verifica si está disponible ahora",
            )
    except Exception:  # noqa: BLE001 — the reception heads-up must never break the reply
        logger.warning("auto_reply: encargada heads-up failed conv=%s", conversation_id)

    # A/B GREETING: on the FIRST reply only (no prior outbound at all), assign a
    # greeting bucket (idempotent) so the opener's tone is nudged and conversion
    # can be measured per bucket. Fail-soft: a failure just skips the nudge.
    ab_variant: str | None = None
    if _AB_GREETING_ENABLED and not any(m.role == "mamai" for m in msgs):
        try:
            chosen = persona.AB_VARIANTS[conversation_id % len(persona.AB_VARIANTS)]
            ab_variant = await queries.assign_ab_variant(kpi, conversation_id, chosen)
        except Exception:  # noqa: BLE001 — A/B assignment must never break the reply
            logger.warning("auto_reply: ab variant assign failed conv=%s", conversation_id)
            ab_variant = None

    reply = await reply_engine.generate_reply(
        kpi,
        casa_id=detail.casa_id,
        conv_id=conversation_id,
        incoming_text=last_incoming,
        lang=None,
        client_name=detail.contact_name or "",
        outcall_base_eur=outcall_base,
        outcall_taxi_low=outcall_taxi_low,
        outcall_taxi_high=outcall_taxi_high,
        outcall_defer=outcall_defer,
        ab_variant=ab_variant,
    )
    if not reply:
        return

    # (e) Human-like behaviour: mark read, brief read pause, typing presence,
    # bounded typing pause. WAHA exposes no stop_typing/sendSeen — sending the
    # message clears the typing presence client-side, so we just send. All
    # WahaClient calls swallow HTTP errors internally (best-effort).
    # (f) Mode branch. The human-like presence (read receipt + "typing…") and the
    # bounded delay run ONLY in auto mode — copilot must stay completely invisible
    # to the client (no blue ticks, no typing indicator); it just stores a
    # suggestion for the receptionist to send manually.
    if mode == "auto":
        waha: WahaClient = ctx["waha"]
        redis = ctx.get("redis")  # reuse the worker's redis handle (may be None)
        session, chat = detail.waha_session, detail.contact_jid
        # Presence is best-effort: WahaClient only catches HTTPStatusError, so a
        # transport-level WAHA error here must not abort the send.
        try:
            await waha.mark_read(session, chat)
            await asyncio.sleep(random.uniform(*_READ_DELAY_S))
            await waha.start_typing(session, chat)
        except Exception:  # noqa: BLE001 — presence is non-critical
            logger.debug("auto_reply: presence failed (non-critical) conv=%s", conversation_id)
        await asyncio.sleep(_humanize_typing_seconds(len(reply)))

        # TOCTOU: after the delay, re-check that a human hasn't taken over the
        # chat in the meantime — never talk over a receptionist.
        if await queries.has_recent_human_outbound(
            kpi, conversation_id, _HUMAN_PAUSE_WINDOW_MIN
        ):
            await queries.set_conversation_agent_status(
                kpi, conversation_id, "paused_human"
            )
            logger.info("auto_reply: human took over during delay conv=%s", conversation_id)
            return
        # DUPLICATE BACKSTOP: if ANOTHER Sara reply landed during our human-like
        # delay (a bucket-straddling job, or the conv lock expired mid-delay), abort
        # — never double-reply the same turn. Complements the conv lock + the start
        # idempotency guard for the residual sub-second race.
        if await queries.last_out_is_agent_generated(kpi, conversation_id):
            logger.info(
                "auto_reply: another Sara reply landed during delay — skip conv=%s",
                conversation_id,
            )
            return
        # ANTI-BAN: enforce the min-gap (+jitter) between two sends on the SAME
        # number. Bounded and lives in this JOB, not the cron loop. FAIL-SAFE:
        # pace falls back to an in-process gate when redis is None/erroring.
        # Send the reply, split into up to 2 human-like bubbles when it's long
        # (each bubble is a full anti-ban send: gate → pace → send → record).
        await _send_reply_bubbles(kpi, waha, redis, conversation_id, session, chat, reply)
        # PHOTO CARDS — desactivadas (_PHOTO_CARDS_ENABLED=False): las chicas están
        # en la web y Sara pasa el enlace, así que no manda fotos. Se conserva el
        # código tras el flag por si se quiere reactivar. Cada foto era un envío
        # propio con el mismo contrato anti-ban y FAIL-SOFT que el texto.
        if _PHOTO_CARDS_ENABLED:
            await _send_photo_cards(
                kpi, waha, redis, conversation_id, session, chat,
                casa_id=detail.casa_id, reply=reply, incoming=last_incoming,
            )
    elif mode == "copilot":
        # DEDUP: supersede the prior unsent draft (if any) BEFORE storing the new
        # one, so a receptionist who is away never returns to N stacked
        # suggestions for ONE conversation — at most one stays pending.
        await queries.supersede_pending_suggestions(kpi, conversation_id)
        await queries.insert_alert(
            kpi,
            type="agent_suggestion",
            severity="info",
            conversation_id=conversation_id,
            inbox_id=detail.casa_id,
            message=reply[:_SUGGESTION_MAXLEN],  # store suggestion; DO NOT send
        )
        logger.info("auto_reply: suggestion stored conv=%s", conversation_id)


async def _send_reply_bubbles(
    kpi: asyncpg.Pool,
    waha: WahaClient,
    redis: object | None,
    conversation_id: int,
    session: str,
    chat: str,
    reply: str,
) -> None:
    """Send the text reply as 1 or 2 bubbles (see `_split_reply`).

    Each bubble is a FULL anti-ban send and mirrors the photo loop's contract:
    the 2nd+ bubble re-checks `allow_send` (stop the burst if the number hit its
    cap), then pace → send → record_send. A brief human-like pause precedes the
    2nd bubble. The 1st bubble was already gated by the caller's allow_send +
    typing delay, so it sends straight away."""
    bubbles = _split_reply(reply)
    if not bubbles:
        return
    for idx, part in enumerate(bubbles):
        if idx > 0:
            # 2nd+ bubble: respect the per-number caps mid-burst (FAIL-SAFE via
            # in-process fallback when redis is None/erroring), like photos.
            allowed, reason = await rate_limit.allow_send(redis, session)
            if not allowed:
                logger.info(
                    "auto_reply: 2nd bubble rate-limited (stop) conv=%s reason=%s",
                    conversation_id, reason,
                )
                return
            await asyncio.sleep(random.uniform(*_BUBBLE_GAP_S))
        await rate_limit.pace(redis, session)
        await _send_and_persist(kpi, waha, conversation_id, session, chat, part)
        # ANTI-BAN: count this successful auto-send against the per-number caps
        # (records into the fallback too). Only reached if the send did not raise.
        await rate_limit.record_send(redis, session)


async def _send_and_persist(
    kpi: asyncpg.Pool,
    waha: WahaClient,
    conversation_id: int,
    session: str,
    chat: str,
    reply: str,
) -> None:
    """Send the reply via WAHA and persist it as an agent-generated outbound.

    Mirrors the receptionist send path's dedup reasoning: insert with the real
    WAHA id + agent_generated=TRUE so the later `message.any` webhook hits
    ON CONFLICT and is a no-op, preserving the TRUE flag. If no id can be
    extracted (rare), insert a synthetic agent_generated=TRUE row instead so the
    reply is never misread as a receptionist message on the next turn.
    """
    res = await waha.send_text(session, chat, reply)
    waha_msg_id = extract_waha_msg_id(res)
    # The reply is already DELIVERED. If the conversation was merged away
    # mid-send (rare: our conv lock expired and the auto-merge sweep won the
    # race, DELETEing this conversation), the INSERT's FK would crash the job and
    # arq would retry it — re-sending the same reply. Swallow the FK instead: the
    # client already got the message, we just skip the now-impossible DB record.
    try:
        async with kpi.acquire() as conn:
            if waha_msg_id:
                await conn.execute(
                    """
                    INSERT INTO message (
                        conversation_id, waha_msg_id, direction, body,
                        ack, agent_generated, created_at
                    )
                    VALUES ($1, $2, 'out', $3, 0, TRUE, now())
                    ON CONFLICT (waha_msg_id) DO UPDATE SET agent_generated = TRUE
                    """,
                    conversation_id, waha_msg_id, reply,
                )
            else:
                # No parseable WAHA id (rare). Still record the reply as an
                # agent-generated row (synthetic id) so it isn't later mistaken for
                # a receptionist message — otherwise the next client turn would
                # self-trigger paused_human.
                await conn.execute(
                    """
                    INSERT INTO message (
                        conversation_id, waha_msg_id, direction, body,
                        ack, agent_generated, created_at
                    )
                    VALUES ($1, $2, 'out', $3, 0, TRUE, now())
                    ON CONFLICT (waha_msg_id) DO NOTHING
                    """,
                    conversation_id, f"agent-local:{uuid.uuid4()}", reply,
                )
                logger.warning(
                    "auto_reply: WAHA send returned no extractable id; inserted "
                    "synthetic agent row. conversation_id=%s response_type=%s keys=%s",
                    conversation_id, type(res).__name__,
                    list(res.keys()) if isinstance(res, dict) else None,
                )
            await conn.execute(
                "UPDATE conversation SET last_message_at = now(), updated_at = now() WHERE id = $1",
                conversation_id,
            )
    except asyncpg.ForeignKeyViolationError:
        logger.warning(
            "auto_reply: conversation %s vanished mid-send (merged?) — reply "
            "delivered but not persisted", conversation_id,
        )
        return
    logger.info("auto_reply: sent conv=%s len=%s", conversation_id, len(reply))


async def _send_photo_cards(
    kpi: asyncpg.Pool,
    waha: WahaClient,
    redis: object | None,
    conversation_id: int,
    session: str,
    chat: str,
    *,
    casa_id: int,
    reply: str,
    incoming: str,
) -> None:
    """Send up to `_MAX_PHOTOS` girl photo cards AFTER the text reply.

    Selection is deterministic (no LLM): the girls Sara named in `reply`, or the
    first candidates on a bare photo request — see `photo_select`. The candidate
    roster is loaded with the dedicated photo-only query (girls available today
    WITH a non-empty photo_url).

    ANTI-BAN: every photo is a full send — gated by `allow_send`, paced, then
    counted by `record_send` (photos count toward the per-number caps). If the
    gate blocks, we STOP sending further photos. When `redis` is None/erroring the
    limiter uses an in-process fallback (FAIL-SAFE), mirroring the text path.

    DEDUP: photos already sent in THIS conversation are excluded so the same
    girl's card is never re-sent every turn (a bot tell + media-repetition ban
    signal).

    FAIL-SOFT: each photo send is wrapped in try/except — a failed image logs a
    warning and continues to the next; it NEVER raises out of the job nor breaks
    the already-sent text reply.
    """
    try:
        girls = await queries.get_available_girls_with_photo(kpi, casa_id)
    except Exception as exc:  # noqa: BLE001 — photo loading must never break the text
        logger.warning(
            "auto_reply: photo roster load failed (skip photos) conv=%s err=%s",
            conversation_id, exc,
        )
        return

    selected = photo_select.select_photo_girls(girls, reply, incoming)
    if not selected:
        return

    # DEDUP: never re-send a photo already sent in THIS conversation.
    try:
        sent_urls = await queries.get_sent_photo_urls(kpi, conversation_id)
    except Exception as exc:  # noqa: BLE001 — dedup failure must not break the send
        logger.warning("auto_reply: sent-photo lookup failed (no dedup) conv=%s err=%s", conversation_id, exc)
        sent_urls = set()
    selected = [g for g in selected if (g.photo_url or "") not in sent_urls]
    if not selected:
        return

    for girl in selected:
        # ANTI-BAN gate per photo (FAIL-SAFE via in-process fallback): a blocked
        # number stops the photo burst (the text reply already went out).
        allowed, reason = await rate_limit.allow_send(redis, session)
        if not allowed:
            logger.info(
                "auto_reply: photo rate-limited (stop) conv=%s session=%s reason=%s",
                conversation_id, session, reason,
            )
            return
        await rate_limit.pace(redis, session)

        caption = photo_select.build_caption(girl)
        try:
            await _send_photo_and_persist(
                kpi, waha, conversation_id, session, chat,
                photo_url=girl.photo_url or "", caption=caption,
            )
        except Exception as exc:  # noqa: BLE001 — a failed image must not break the reply
            logger.warning(
                "auto_reply: photo send failed (continue) conv=%s girl=%s err=%s",
                conversation_id, girl.name, exc,
            )
            continue

        # Count the successful photo send against the per-number caps (fallback
        # too). Only reached when the send+persist did not raise.
        await rate_limit.record_send(redis, session)


async def _send_photo_and_persist(
    kpi: asyncpg.Pool,
    waha: WahaClient,
    conversation_id: int,
    session: str,
    chat: str,
    *,
    photo_url: str,
    caption: str,
) -> None:
    """Send one image card via WAHA and persist it as an agent-generated outbound.

    Mirrors `_send_and_persist` (same dedup reasoning + `extract_waha_msg_id` +
    both ON CONFLICT branches + conversation bump) but writes the media columns:
    `media_url` (the photo) and `media_mime`, with the caption as `body`. Raises
    on a WAHA send error so the caller's try/except can fail-soft per photo.
    """
    res = await waha.send_image(session, chat, photo_url, caption)
    waha_msg_id = extract_waha_msg_id(res)
    async with kpi.acquire() as conn:
        if waha_msg_id:
            await conn.execute(
                """
                INSERT INTO message (
                    conversation_id, waha_msg_id, direction, body,
                    media_url, media_mime, ack, agent_generated, created_at
                )
                VALUES ($1, $2, 'out', $3, $4, $5, 0, TRUE, now())
                ON CONFLICT (waha_msg_id) DO UPDATE SET agent_generated = TRUE
                """,
                conversation_id, waha_msg_id, caption, photo_url, _PHOTO_MIME,
            )
        else:
            # No parseable WAHA id (rare). Still record the photo as an
            # agent-generated row (synthetic id) so the next client turn does not
            # self-trigger paused_human by misreading it as a receptionist send.
            await conn.execute(
                """
                INSERT INTO message (
                    conversation_id, waha_msg_id, direction, body,
                    media_url, media_mime, ack, agent_generated, created_at
                )
                VALUES ($1, $2, 'out', $3, $4, $5, 0, TRUE, now())
                ON CONFLICT (waha_msg_id) DO NOTHING
                """,
                conversation_id, f"agent-local:{uuid.uuid4()}", caption,
                photo_url, _PHOTO_MIME,
            )
            logger.warning(
                "auto_reply: photo WAHA send returned no extractable id; inserted "
                "synthetic agent row. conversation_id=%s response_type=%s",
                conversation_id, type(res).__name__,
            )
        await conn.execute(
            "UPDATE conversation SET last_message_at = now(), updated_at = now() WHERE id = $1",
            conversation_id,
        )
    logger.info("auto_reply: photo sent conv=%s url_len=%s", conversation_id, len(photo_url))
