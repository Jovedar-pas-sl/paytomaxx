"""Conversation detail view with AI insights sidebar + send message."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Form, HTTPException, Request, status
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from app import queries, team
from app.agent import reply_engine
from app.agent.auto_reply import _send_and_persist
from app.deps import Arq, CurrentUser, KpiDB, Waha
from app.template_env import templates
from app.waha_msgid import extract_waha_msg_id as _extract_waha_msg_id

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/conversation/{conversation_id}", response_class=HTMLResponse)
async def conversation_detail(
    conversation_id: int,
    request: Request,
    user: CurrentUser,
    kpi: KpiDB,
) -> HTMLResponse:
    detail = await queries.get_conversation_detail(kpi, conversation_id)
    if not detail:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversación no encontrada")

    messages = await queries.list_messages_for_conversation(kpi, conversation_id)

    await queries.clear_unread(kpi, conversation_id)

    # Siblings: other conversations in same casa (for merge dropdown)
    # + detect likely-same-contact candidate for auto-suggestion.
    # Single CTE query — avoids N+1 on message counts for 20 siblings.
    async with kpi.acquire() as conn:
        siblings_rows = await conn.fetch(
            """
            WITH counts AS (
                SELECT m.conversation_id,
                       sum(CASE WHEN m.direction='in'  THEN 1 ELSE 0 END)::int AS msgs_in,
                       sum(CASE WHEN m.direction='out' THEN 1 ELSE 0 END)::int AS msgs_out
                FROM message m
                JOIN conversation c ON c.id = m.conversation_id
                WHERE c.casa_id = $1
                GROUP BY m.conversation_id
            )
            SELECT c.id, ct.name, ct.phone, ct.waha_jid,
                   c.last_message_at,
                   coalesce(co.msgs_in, 0)  AS msgs_in,
                   coalesce(co.msgs_out, 0) AS msgs_out
            FROM conversation c
            JOIN contact ct ON ct.id = c.contact_id
            LEFT JOIN counts co ON co.conversation_id = c.id
            WHERE c.casa_id = $1 AND c.id != $2
            ORDER BY c.last_message_at DESC NULLS LAST
            LIMIT 20
            """,
            detail.casa_id, conversation_id,
        )
        my_stats = await conn.fetchrow(
            """
            SELECT
              sum(CASE WHEN direction='in'  THEN 1 ELSE 0 END)::int AS msgs_in,
              sum(CASE WHEN direction='out' THEN 1 ELSE 0 END)::int AS msgs_out
            FROM message WHERE conversation_id=$1
            """,
            conversation_id,
        )

    siblings = [
        {
            "id": r["id"],
            "label": r["name"] or r["phone"] or (r["waha_jid"][:20] + "…"),
            "phone": r["phone"],
            "msgs_in": r["msgs_in"],
            "msgs_out": r["msgs_out"],
        }
        for r in siblings_rows
    ]

    # Heuristic: suggest merge if this conv is one-sided (only in OR only out)
    # AND a sibling has complementary one-sidedness + overlapping time window
    suggested_merge = None
    me_only_in = my_stats["msgs_in"] > 0 and my_stats["msgs_out"] == 0
    me_only_out = my_stats["msgs_out"] > 0 and my_stats["msgs_in"] == 0
    if me_only_in or me_only_out:
        for s in siblings:
            # Complementary direction
            complementary = (me_only_in and s["msgs_out"] > 0 and s["msgs_in"] == 0) \
                         or (me_only_out and s["msgs_in"] > 0 and s["msgs_out"] == 0)
            if complementary:
                suggested_merge = s
                break

    # Agent state for the header pill + (if present) the pending copilot draft.
    # `mode` + `agent_status` drive the SAME resolve_pill resolver the chat list
    # uses (single source of truth), so the header banner stays in lockstep.
    agent_status = await queries.get_conversation_agent_status(kpi, conversation_id)
    agent_mode = await queries.get_wa_mode_for_conversation(kpi, conversation_id)
    pending_suggestion = await queries.get_pending_suggestion(kpi, conversation_id)
    # Fail-soft: the outcome column ships in migration 0020 — if the page is hit
    # in the brief window before `alembic upgrade head`, fall back to None instead
    # of 500-ing the conversation view.
    try:
        outcome = await queries.get_conversation_outcome(kpi, conversation_id)
    except Exception:
        outcome = None

    header = {
        "id": detail.id,
        "account_id": detail.casa_id,
        "account_name": detail.casa_name,
        "inbox_id": detail.casa_id,
        "inbox_name": detail.casa_name,
        "contact_name": detail.contact_name,
        "phone_number": detail.contact_phone,
        "status": detail.status,
        "created_at": detail.created_at,
        "agent_status": agent_status,
        "mode": agent_mode,
        "outcome": outcome,
    }

    msgs = [
        {
            "id": m.id,
            "content": m.body or "",
            "message_type": 0 if m.direction == "in" else 1,
            "created_at": m.created_at,
            "ack": m.ack,
            "media_url": m.media_url,
            "media_mime": m.media_mime,
            "agent_generated": m.agent_generated,
        }
        for m in messages
    ]

    return templates.TemplateResponse(
        request, "conversation.html",
        {
            "user": user,
            "header": header,
            "messages": msgs,
            "siblings": siblings,
            "suggested_merge": suggested_merge,
            "pending_suggestion": pending_suggestion,
        },
    )


@router.get("/conversation/{conversation_id}/embed", response_class=HTMLResponse)
async def conversation_embed(
    conversation_id: int,
    request: Request,
    user: CurrentUser,  # noqa: ARG001 — CurrentUser enforces auth
    kpi: KpiDB,
) -> HTMLResponse:
    """Embeddable conversation panel for the dashboard inline pane.

    Lighter than `conversation_detail` (no siblings / merge heuristics): just
    the header, the live messages and a reply box. Returned both on first
    open (recent-conversations item → #conv-pane) and after an inline send.
    """
    detail = await queries.get_conversation_detail(kpi, conversation_id)
    if not detail:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversación no encontrada")

    messages = await queries.list_messages_for_conversation(kpi, conversation_id)
    await queries.clear_unread(kpi, conversation_id)

    agent_status = await queries.get_conversation_agent_status(kpi, conversation_id)
    agent_mode = await queries.get_wa_mode_for_conversation(kpi, conversation_id)
    # Copilot draft (if the WA number is in copilot mode). Drives the inline
    # "Sugerencia de Sara" card with Editar/Enviar/Descartar.
    pending_suggestion = await queries.get_pending_suggestion(kpi, conversation_id)

    header = {
        "id": detail.id,
        "account_name": detail.casa_name,
        "contact_name": detail.contact_name,
        "phone_number": detail.contact_phone,
        "status": detail.status,
        "agent_status": agent_status,
        "mode": agent_mode,
    }
    msgs = [
        {
            "id": m.id,
            "content": m.body or "",
            "message_type": 0 if m.direction == "in" else 1,
            "created_at": m.created_at,
            "ack": m.ack,
            "media_url": m.media_url,
            "media_mime": m.media_mime,
            "agent_generated": m.agent_generated,
        }
        for m in messages
    ]
    return templates.TemplateResponse(
        request,
        "partials/conversation_embed.html",
        {
            "header": header,
            "messages": msgs,
            "conversation_id": conversation_id,
            "pending_suggestion": pending_suggestion,
        },
    )


@router.post("/conversation/{conversation_id}/send")
async def conversation_send(
    conversation_id: int,
    request: Request,
    user: CurrentUser,
    kpi: KpiDB,
    waha: Waha,
    body: str = Form(...),
) -> Response:
    detail = await queries.get_conversation_detail(kpi, conversation_id)
    if not detail:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)

    try:
        res = await waha.send_text(detail.waha_session, detail.contact_jid, body)
    except Exception as exc:
        logger.exception("WAHA send failed: %s", exc)
        raise HTTPException(status_code=502, detail="WAHA error") from exc

    waha_msg_id = _extract_waha_msg_id(res)

    async with kpi.acquire() as conn:
        if waha_msg_id:
            # Insert with real id; webhook (`message.any` fromMe=true) hits ON CONFLICT
            # and is a no-op, preventing duplicates.
            # agent_generated=FALSE marks this as a HUMAN (receptionist) send — it
            # both excludes the row from the bot count and feeds the
            # has_recent_human_outbound() pause window. Explicit FALSE documents
            # intent and protects against the column default ever changing.
            # sent_by_user_id attributes the reply to the logged-in human ("quién
            # contestó"). DO UPDATE (not DO NOTHING) so that if the webhook's
            # fromMe row landed first, we still backfill the author — but never
            # overwrite an attribution that is already set (COALESCE keeps it).
            await conn.execute(
                """
                INSERT INTO message (conversation_id, waha_msg_id, direction, body, ack, agent_generated, sent_by_user_id, created_at)
                VALUES ($1, $2, 'out', $3, 0, FALSE, $4, now())
                ON CONFLICT (waha_msg_id) DO UPDATE
                SET sent_by_user_id = COALESCE(message.sent_by_user_id, EXCLUDED.sent_by_user_id)
                """,
                conversation_id, waha_msg_id, body, user.id,
            )
        else:
            # Couldn't extract id from WAHA response → don't insert locally.
            # The webhook will be the single source of truth (1-3s delay until UI shows it).
            # Inserting NULL would defeat the unique-on-waha_msg_id dedup and create duplicates.
            logger.warning(
                "WAHA send_text returned no extractable id; deferring insert to webhook. "
                "conversation_id=%s response_type=%s",
                conversation_id, type(res).__name__,
            )
        # Receptionist handoff: a human replied, so pause the agent. Idempotent;
        # stays paused until manual reset (locked decision). agent_paused_at is
        # stamped here so the panel can show when the human took over.
        await conn.execute(
            """
            UPDATE conversation
            SET last_message_at = now(), updated_at = now(),
                agent_status = 'paused_human', agent_paused_at = now()
            WHERE id = $1
            """,
            conversation_id,
        )

    # Inline send from the dashboard pane (HTMX): return the embed fragment so
    # the pane re-paints with the new bubble in place — no full-page redirect.
    # The classic full conversation page posts without HX-Request → 303 as before.
    if request.headers.get("HX-Request"):
        return await conversation_embed(conversation_id, request, user, kpi)

    return RedirectResponse(
        url=f"/conversation/{conversation_id}",
        status_code=status.HTTP_303_SEE_OTHER,
    )


@router.post("/conversation/{conversation_id}/send-suggestion/{alert_id}")
async def conversation_send_suggestion(
    conversation_id: int,
    alert_id: int,
    request: Request,
    user: CurrentUser,
    kpi: KpiDB,
    waha: Waha,
    body: str | None = Form(None),
) -> Response:
    """1-click copilot send: send a stored agent_suggestion as the agent.

    Reuses the existing agent send/persist path so the message lands with
    agent_generated=TRUE (it must NOT look like a human send, otherwise the bot
    would self-pause via has_recent_human_outbound). Then acks the suggestion
    alert and redirects (303) like the sibling controls.

    The suggestion text comes from the alert by default; an optional hidden
    `body` form field overrides it (e.g. if the receptionist edited the draft).
    """
    alert = await queries.get_alert(kpi, alert_id)
    if not alert or alert.type != "agent_suggestion":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sugerencia no encontrada")
    # Guard: the alert must belong to this conversation (prevents sending one
    # conversation's draft into another via a crafted id).
    if alert.conversation_id != conversation_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Sugerencia de otra conversación")

    text = (body or alert.message or "").strip()
    if not text:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Sugerencia vacía")

    detail = await queries.get_conversation_detail(kpi, conversation_id)
    if not detail:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)

    try:
        # Reuse the agent send path: persists agent_generated=TRUE (DO UPDATE),
        # so the later webhook echo keeps the TRUE flag and the bot is not fooled.
        await _send_and_persist(
            kpi, waha, conversation_id, detail.waha_session, detail.contact_jid, text
        )
    except Exception as exc:
        logger.exception("copilot send-suggestion failed: %s", exc)
        raise HTTPException(status_code=502, detail="WAHA error") from exc

    # NOTE: accepting a copilot draft does NOT pause Sara. Copilot never
    # auto-sends (it only drafts), so there is no risk of the bot talking over a
    # human — and pausing here would break the per-message review loop (after one
    # accept Sara would stop drafting the next reply). The explicit "Desactivar"
    # control (agent-pause) is how a human stops Sara in a conversation.
    # Ack ALL unacked suggestions for this conversation (not just alert_id) so the
    # Sara badge clears fully. Dedup keeps this to one row in practice, but legacy
    # rows or a race could leave extras — clear them all (idempotent).
    await queries.ack_all_suggestions(kpi, conversation_id)

    # Inline (dashboard pane) → re-paint with the sent message + no draft.
    if request.headers.get("HX-Request"):
        return await conversation_embed(conversation_id, request, user, kpi)
    return RedirectResponse(
        url=f"/conversation/{conversation_id}",
        status_code=status.HTTP_303_SEE_OTHER,
    )


@router.post("/conversation/{conversation_id}/dismiss-suggestion/{alert_id}")
async def conversation_dismiss_suggestion(
    conversation_id: int,
    alert_id: int,
    request: Request,
    user: CurrentUser,
    kpi: KpiDB,
) -> Response:
    """Descartar (ack) a copilot draft WITHOUT sending it. The next client message
    produces a fresh draft. Inline (HX) returns the embed fragment; otherwise 303."""
    alert = await queries.get_alert(kpi, alert_id)
    if not alert or alert.type != "agent_suggestion" or alert.conversation_id != conversation_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sugerencia no encontrada")
    await queries.ack_alert(kpi, alert_id)
    await team.audit(
        kpi, action="sara_suggestion_dismiss", actor_label=user.display_name,
        user_id=user.id, entity_type="conversation", entity_id=conversation_id,
    )
    if request.headers.get("HX-Request"):
        return await conversation_embed(conversation_id, request, user, kpi)
    return RedirectResponse(
        url=f"/conversation/{conversation_id}",
        status_code=status.HTTP_303_SEE_OTHER,
    )


@router.post("/conversation/{conversation_id}/agent-pause")
async def conversation_agent_pause(
    conversation_id: int,
    request: Request,
    user: CurrentUser,
    kpi: KpiDB,
) -> Response:
    """Desactivar Sara en esta conversación: pausa el agente (paused_human, hasta
    reactivar) y descarta cualquier borrador copiloto pendiente. Inline → embed."""
    await queries.set_conversation_agent_status(kpi, conversation_id, "paused_human")
    await queries.ack_all_suggestions(kpi, conversation_id)
    await team.audit(
        kpi, action="sara_pause", actor_label=user.display_name, user_id=user.id,
        entity_type="conversation", entity_id=conversation_id,
    )
    if request.headers.get("HX-Request"):
        return await conversation_embed(conversation_id, request, user, kpi)
    return RedirectResponse(
        url=f"/conversation/{conversation_id}",
        status_code=status.HTTP_303_SEE_OTHER,
    )


@router.post("/conversation/{conversation_id}/agent-resume")
async def conversation_agent_resume(
    conversation_id: int,
    request: Request,
    user: CurrentUser,
    kpi: KpiDB,
) -> Response:
    """Reactivar Sara en esta conversación: estado a activa + se reconocen las
    alertas de riesgo (si las hubo). Inline → embed; otherwise 303."""
    await queries.set_conversation_agent_status(kpi, conversation_id, "active")
    await queries.ack_risk_alerts(kpi, conversation_id)
    await team.audit(
        kpi, action="sara_resume", actor_label=user.display_name, user_id=user.id,
        entity_type="conversation", entity_id=conversation_id,
    )
    if request.headers.get("HX-Request"):
        return await conversation_embed(conversation_id, request, user, kpi)
    return RedirectResponse(
        url=f"/conversation/{conversation_id}",
        status_code=status.HTTP_303_SEE_OTHER,
    )


@router.post("/conversation/{conversation_id}/suggest")
async def conversation_suggest(
    conversation_id: int,
    request: Request,
    user: CurrentUser,
    kpi: KpiDB,
) -> Response:
    """🪄 Varita: genera AHORA un borrador de Sara a partir de los últimos
    mensajes del cliente (en cualquier modo), lo guarda como la sugerencia
    pendiente y re-pinta el panel para que la tarjeta aparezca bajo la caja de
    escribir. No envía nada: solo sugiere. Inline (HX) → embed; si no, 303.

    Sin guardarraíles: el humano revisa el borrador antes de enviarlo, así que
    no hay riesgo (a diferencia del auto-send del worker, que sí los corre)."""
    detail = await queries.get_conversation_detail(kpi, conversation_id)
    if not detail:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversación no encontrada")

    messages = await queries.list_messages_for_conversation(kpi, conversation_id)
    last_incoming = next(
        (m.body for m in reversed(messages) if m.direction == "in" and m.body), ""
    )

    # generate_reply never raises (localized fallback on failure). lang=None lets
    # the engine resolve the casa's default language.
    reply = await reply_engine.generate_reply(
        kpi,
        casa_id=detail.casa_id,
        conv_id=conversation_id,
        incoming_text=last_incoming or "",
        client_name=detail.contact_name or "",
    )
    if reply:
        # Store as the pending copilot draft so it flows through the SAME card +
        # send-suggestion path (Editar/Enviar/Descartar). Supersede first → at
        # most one pending draft per conversation.
        await queries.supersede_pending_suggestions(kpi, conversation_id)
        await queries.insert_alert(
            kpi,
            type="agent_suggestion",
            severity="info",
            conversation_id=conversation_id,
            inbox_id=detail.casa_id,
            message=reply[:2000],
        )
    await team.audit(
        kpi, action="sara_suggest_wand", actor_label=user.display_name,
        user_id=user.id, entity_type="conversation", entity_id=conversation_id,
    )
    if request.headers.get("HX-Request"):
        return await conversation_embed(conversation_id, request, user, kpi)
    return RedirectResponse(
        url=f"/conversation/{conversation_id}",
        status_code=status.HTTP_303_SEE_OTHER,
    )


@router.post("/conversation/{conversation_id}/resolve")
async def conversation_resolve(
    conversation_id: int,
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
    arq: Arq,
) -> RedirectResponse:
    """Mark conversation as resolved.

    (Per-conversation IA analysis retired — insights now come from the block
    analyzer at número/casa level, so resolving no longer enqueues a per-chat job.)
    """
    await queries.set_conversation_status(kpi, conversation_id, "resolved")
    return RedirectResponse(
        url=f"/conversation/{conversation_id}",
        status_code=status.HTTP_303_SEE_OTHER,
    )


@router.post("/conversation/{conversation_id}/outcome")
async def conversation_outcome(
    conversation_id: int,
    user: CurrentUser,
    kpi: KpiDB,
    outcome: str = Form(""),
) -> RedirectResponse:
    """Toggle the conversation's conversion outcome. An empty value clears the
    mark; any value sets 'reservado' (the only outcome for now). This is the
    conversion signal used by the A/B greeting readout."""
    value = "reservado" if outcome.strip() else None
    await queries.set_conversation_outcome(
        kpi, conversation_id, value, getattr(user, "id", None)
    )
    return RedirectResponse(
        url=f"/conversation/{conversation_id}",
        status_code=status.HTTP_303_SEE_OTHER,
    )


@router.post("/conversation/{conversation_id}/auto-merge")
async def conversation_auto_merge(
    conversation_id: int,
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
) -> RedirectResponse:
    """Use Claude to detect which sibling conversation is the same client
    and auto-merge into it. Requires confidence >= 0.7."""
    from app.analyzer.skills import Message, SiblingConvo, detect_same_client

    detail = await queries.get_conversation_detail(kpi, conversation_id)
    if not detail:
        raise HTTPException(status_code=404)

    async with kpi.acquire() as conn:
        # Target messages
        target_msgs_rows = await conn.fetch(
            """
            SELECT body, direction, extract(epoch from created_at)::int AS ts
            FROM message WHERE conversation_id = $1
            ORDER BY created_at ASC LIMIT 25
            """,
            conversation_id,
        )
        # Sibling conversations — same casa, recent
        sibling_ids = await conn.fetch(
            """
            SELECT c.id, ct.name, ct.phone, ct.waha_jid
            FROM conversation c
            JOIN contact ct ON ct.id = c.contact_id
            WHERE c.casa_id = $1 AND c.id != $2
              AND c.last_message_at > now() - interval '24 hours'
            ORDER BY c.last_message_at DESC LIMIT 8
            """,
            detail.casa_id, conversation_id,
        )
        siblings: list[SiblingConvo] = []
        for s in sibling_ids:
            s_msgs = await conn.fetch(
                """
                SELECT body, direction, extract(epoch from created_at)::int AS ts
                FROM message WHERE conversation_id = $1
                ORDER BY created_at ASC LIMIT 15
                """,
                s["id"],
            )
            label = s["name"] or s["phone"] or (s["waha_jid"][:24] + "…")
            siblings.append(SiblingConvo(
                conv_id=s["id"],
                label=label,
                messages=[Message(
                    ts=r["ts"],
                    role="cliente" if r["direction"] == "in" else "mamai",
                    content=(r["body"] or "")[:200],
                ) for r in s_msgs],
            ))

    if not siblings:
        raise HTTPException(status_code=400, detail="No hay otras conversaciones candidatas en esta casa (últimas 24h).")

    target_label = detail.contact_name or detail.contact_phone or "target"
    target_msgs = [
        Message(
            ts=r["ts"],
            role="cliente" if r["direction"] == "in" else "mamai",
            content=(r["body"] or "")[:200],
        )
        for r in target_msgs_rows
    ]

    try:
        result = await detect_same_client(target_msgs, target_label, siblings)
    except Exception as exc:
        logger.exception("auto-merge detect failed")
        raise HTTPException(status_code=502, detail=f"Error IA: {exc}") from exc

    if not result.best_match_id or result.confidence < 0.7:
        raise HTTPException(
            status_code=400,
            detail=f"IA no detecta coincidencia clara (confianza {result.confidence:.0%}). {result.reasoning}",
        )

    # Call the manual merge logic
    return await conversation_merge(
        source_id=conversation_id,
        target_id=result.best_match_id,
        user=user,  # type: ignore[arg-type]
        kpi=kpi,
    )


@router.post("/conversation/{source_id}/merge-into/{target_id}")
async def conversation_merge(
    source_id: int,
    target_id: int,
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
) -> RedirectResponse:
    """Merge source conversation INTO target: moves all messages, then deletes
    source conv + source contact (if orphaned). Used when the same person has
    two JIDs (typically @c.us + @lid privacy duplicate)."""
    if source_id == target_id:
        raise HTTPException(status_code=400, detail="same id")
    async with kpi.acquire() as conn:
        async with conn.transaction():
            src = await conn.fetchrow(
                "SELECT contact_id, casa_id FROM conversation WHERE id = $1", source_id
            )
            tgt = await conn.fetchrow(
                "SELECT contact_id, casa_id FROM conversation WHERE id = $1", target_id
            )
            if not src or not tgt:
                raise HTTPException(status_code=404)
            if src["casa_id"] != tgt["casa_id"]:
                raise HTTPException(status_code=400, detail="different casas")

            # Move all messages source → target
            await conn.execute(
                "UPDATE message SET conversation_id = $1 WHERE conversation_id = $2",
                target_id, source_id,
            )
            # Bump target's last_message_at + unread
            await conn.execute(
                """
                UPDATE conversation SET
                    last_message_at = GREATEST(last_message_at, (
                        SELECT last_message_at FROM (SELECT 1) _
                        WHERE EXISTS (SELECT 1 FROM message m WHERE m.conversation_id = $1)
                    )),
                    unread_count = unread_count + (SELECT unread_count FROM conversation WHERE id = $2),
                    updated_at = now()
                WHERE id = $1
                """,
                target_id, source_id,
            )
            # Delete source conv
            await conn.execute("DELETE FROM conversation WHERE id = $1", source_id)
            # Delete source contact if orphaned
            await conn.execute(
                """
                DELETE FROM contact c
                WHERE c.id = $1
                  AND NOT EXISTS (SELECT 1 FROM conversation WHERE contact_id = c.id)
                """,
                src["contact_id"],
            )

    return RedirectResponse(
        url=f"/conversation/{target_id}",
        status_code=status.HTTP_303_SEE_OTHER,
    )
