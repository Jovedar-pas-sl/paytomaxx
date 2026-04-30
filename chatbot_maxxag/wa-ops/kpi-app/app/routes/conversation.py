"""Conversation detail view with AI insights sidebar + send message."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Form, HTTPException, Request, status
from fastapi.responses import HTMLResponse, RedirectResponse
from app import queries
from app.deps import Arq, CurrentUser, KpiDB, Waha
from app.template_env import templates

logger = logging.getLogger(__name__)
router = APIRouter()


def _extract_waha_msg_id(res: object) -> str:
    """Extract WAHA message id from send_text response.

    WAHA returns `id` either as a string or as a nested dict
    `{"_serialized": "...", "id": "..."}`. Some legacy engines nest it
    under `_data.id`. Returns "" if no id can be extracted.
    """
    if not isinstance(res, dict):
        return ""
    top = res.get("id")
    if isinstance(top, str):
        return top
    if isinstance(top, dict):
        cand = top.get("_serialized") or top.get("id")
        if isinstance(cand, str):
            return cand
    inner = (res.get("_data") or {}).get("id") if isinstance(res.get("_data"), dict) else None
    if isinstance(inner, str):
        return inner
    if isinstance(inner, dict):
        cand = inner.get("_serialized") or inner.get("id")
        if isinstance(cand, str):
            return cand
    return ""


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

    async with kpi.acquire() as conn:
        analysis = await conn.fetchrow(
            "SELECT * FROM analysis WHERE conversation_id = $1",
            conversation_id,
        )

    # Parse JSONB fields that asyncpg returns as strings
    analysis_dict: dict | None = None
    if analysis:
        import json as _json
        analysis_dict = dict(analysis)
        for field in ("coaching", "red_flags", "intent", "next_action", "escalation"):
            v = analysis_dict.get(field)
            if isinstance(v, str):
                try:
                    analysis_dict[field] = _json.loads(v)
                except (TypeError, ValueError):
                    analysis_dict[field] = None

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
        }
        for m in messages
    ]

    return templates.TemplateResponse(
        request, "conversation.html",
        {
            "user": user,
            "header": header,
            "messages": msgs,
            "analysis": analysis_dict,
            "siblings": siblings,
            "suggested_merge": suggested_merge,
        },
    )


@router.post("/conversation/{conversation_id}/send")
async def conversation_send(
    conversation_id: int,
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
    waha: Waha,
    body: str = Form(...),
) -> RedirectResponse:
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
            await conn.execute(
                """
                INSERT INTO message (conversation_id, waha_msg_id, direction, body, ack, created_at)
                VALUES ($1, $2, 'out', $3, 0, now())
                ON CONFLICT (waha_msg_id) DO NOTHING
                """,
                conversation_id, waha_msg_id, body,
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
        await conn.execute(
            "UPDATE conversation SET last_message_at = now(), updated_at = now() WHERE id = $1",
            conversation_id,
        )

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
    """Mark conversation as resolved and enqueue analysis (DI arq pool)."""
    await queries.set_conversation_status(kpi, conversation_id, "resolved")
    await arq.enqueue_job("analyze_conversation_job", int(conversation_id), _defer_by=3)
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
