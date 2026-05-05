"""WAHA webhook — ingests messages into our own inbox tables.

Events handled:
  - message / message.any  → upsert contact + conversation + insert message
  - message.ack            → update message.ack
  - session.status         → alert on FAILED/STOPPED

Security: WAHA signs each webhook body with HMAC-SHA512 using the
secret in WAHA_WEBHOOK_HMAC. The header is `X-Webhook-Hmac` (hex
digest). We verify before parsing.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response, status

from app.deps import Arq, KpiDB
from app.settings import get_settings

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/webhook")


def _verify_hmac(body: bytes, header_sig: str | None) -> bool:
    """Constant-time HMAC verification. Skips when secret unset (dev)."""
    settings = get_settings()
    secret = settings.waha_webhook_hmac.get_secret_value() if settings.waha_webhook_hmac else ""
    if not secret:
        return True  # not configured → allow (development only)
    if not header_sig:
        return False
    expected = hmac.new(secret.encode(), body, hashlib.sha512).hexdigest()
    return hmac.compare_digest(expected, header_sig)


@router.post("/waha")
async def waha_webhook(
    request: Request,
    db: KpiDB,
    arq: Arq,
) -> Response:
    body = await request.body()
    sig = request.headers.get("X-Webhook-Hmac") or request.headers.get("x-webhook-hmac-sha512")
    if not _verify_hmac(body, sig):
        logger.warning("webhook HMAC invalid from %s", request.client.host if request.client else "?")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="bad signature")

    payload = json.loads(body) if body else {}
    event = payload.get("event")
    session = payload.get("session") or "default"
    data = payload.get("payload") or {}

    if event == "session.status":
        await _handle_session_status(db, session, data)
    elif event in ("message", "message.any"):
        # message.any fires for both incoming and outgoing (fromMe=true)
        await _handle_message(db, session, data, arq)
    elif event == "message.ack":
        await _handle_message_ack(db, data)
    else:
        logger.debug("waha event ignored: %s", event)

    return Response(status_code=204)


# ── handlers ──────────────────────────────────────────────────────

async def _handle_session_status(db: KpiDB, session: str, data: dict[str, Any]) -> None:
    status = data.get("status")
    if status in {"FAILED", "STOPPED"}:
        async with db.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO alert (type, severity, message)
                VALUES ('wa_disconnected', 'warning', $1)
                """,
                f"Session '{session}' → {status}",
            )


async def _handle_message(db: KpiDB, session: str, data: dict[str, Any], arq: Any = None) -> None:
    """Upsert contact + conversation, insert message.

    WAHA semantics: `from` always holds the REMOTE party's JID (the
    counter-party of the chat), regardless of direction. `fromMe=true`
    just means we sent it. The `to` field is not present in NOWEB
    payloads, so we always key contacts by `from`.
    """
    msg_id: str | None = data.get("id")
    from_me: bool = bool(data.get("fromMe"))
    chat_id: str | None = data.get("from")
    timestamp_sec: int = int(data.get("timestamp") or 0)
    body: str = data.get("body") or ""
    has_media: bool = bool(data.get("hasMedia"))
    media = data.get("media") or {}

    if not chat_id or not msg_id:
        logger.warning("waha message missing id/chat_id: %s", str(data)[:200])
        return

    # Skip non-1:1 conversations:
    #   @g.us        → groups
    #   @broadcast   → status / broadcast-list entries (not real chats)
    # @lid (privacy-protected IDs) are ACCEPTED — modern WhatsApp users often
    # expose only their @lid, so filtering them drops legit new contacts.
    if chat_id.endswith("@g.us") or chat_id.endswith("@broadcast") or chat_id == "status@broadcast":
        return

    created_at = datetime.fromtimestamp(timestamp_sec, tz=timezone.utc) if timestamp_sec else datetime.now(timezone.utc)
    direction = "out" if from_me else "in"

    # Phone: only for real @c.us JIDs. @lid is an internal privacy ID, not a phone.
    is_lid = chat_id.endswith("@lid")
    local = chat_id.split("@")[0]
    phone = local if not is_lid else None

    # Contact name: only for INCOMING messages. For outgoing (fromMe=true),
    # pushName/notifyName refer to US (our own WA), NOT the recipient —
    # storing them would mislabel the contact (e.g. recipient's row gets
    # our own profile name).
    _d = data.get("_data") or {}
    contact_name = None
    if not from_me:
        contact_name = (
            data.get("pushName")
            or data.get("notifyName")
            or _d.get("notifyName")
            or _d.get("pushName")
            or None
        )

    async with db.acquire() as conn:
        async with conn.transaction():
            wa_row = await conn.fetchrow(
                "SELECT id, casa_id FROM wa_number WHERE session = $1",
                session,
            )
            if not wa_row:
                # Unknown session → create orphan casa + wa_number + alert
                casa_row = await conn.fetchrow(
                    """
                    INSERT INTO casa (name, waha_session)
                    VALUES ($1, $1)
                    ON CONFLICT (waha_session) DO UPDATE SET name = casa.name
                    RETURNING id
                    """,
                    f"⚠ {session}",
                )
                wa_row = await conn.fetchrow(
                    """
                    INSERT INTO wa_number (casa_id, session, label)
                    VALUES ($1, $2, 'Sin asignar')
                    ON CONFLICT (session) DO UPDATE SET session = EXCLUDED.session
                    RETURNING id, casa_id
                    """,
                    casa_row["id"], session,
                )
                await conn.execute(
                    """
                    INSERT INTO alert (type, severity, inbox_id, message)
                    VALUES ('unassigned_wa_session', 'warning', $1, $2)
                    """,
                    casa_row["id"],
                    f"Session '{session}' sin casa asignada — reasigna en /sessions",
                )
            wa_number_id = wa_row["id"]
            casa_id = wa_row["casa_id"]

            contact_row = await conn.fetchrow(
                """
                INSERT INTO contact (waha_jid, name, phone)
                VALUES ($1, $2, $3)
                ON CONFLICT (waha_jid) DO UPDATE
                    SET name = COALESCE(EXCLUDED.name, contact.name)
                RETURNING id
                """,
                chat_id, contact_name, phone,
            )
            contact_id = contact_row["id"]

            conv_row = await conn.fetchrow(
                """
                INSERT INTO conversation (casa_id, wa_number_id, contact_id, last_message_at, status)
                VALUES ($1, $2, $3, $4, 'open')
                ON CONFLICT (wa_number_id, contact_id) DO UPDATE
                    SET last_message_at = EXCLUDED.last_message_at,
                        updated_at = now(),
                        status = CASE WHEN conversation.status = 'resolved' THEN 'open' ELSE conversation.status END
                RETURNING id
                """,
                casa_id, wa_number_id, contact_id, created_at,
            )
            conv_id = conv_row["id"]

            # Insert message (idempotent via waha_msg_id UNIQUE)
            inserted = await conn.fetchrow(
                """
                INSERT INTO message (
                    conversation_id, waha_msg_id, direction, body,
                    media_url, media_mime, ack, created_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                ON CONFLICT (waha_msg_id) DO NOTHING
                RETURNING id
                """,
                conv_id, msg_id, direction, body,
                media.get("url") if has_media else None,
                media.get("mimetype") if has_media else None,
                int(data.get("ack") or 0),
                created_at,
            )

            # Bump unread_count for incoming new messages
            if inserted and direction == "in":
                await conn.execute(
                    "UPDATE conversation SET unread_count = unread_count + 1 WHERE id = $1",
                    conv_id,
                )

            # Merge detection: when a conv is one-sided and a complementary
            # sibling exists in the same casa+WA, record a suggestion alert
            # AND enqueue an auto_merge_job. The job calls Claude to confirm
            # same-client and, if confidence is high enough, executes the merge
            # without admin intervention. Below the confidence threshold the
            # alert remains for manual review.
            #
            # Symmetric: triggers on both incoming (in-only conv + out-only sibling)
            # and outgoing (out-only conv + in-only sibling) so we catch the case
            # where the admin sends first to a new @lid and the client replies later
            # under @c.us (or vice versa).
            sibling_id: int | None = None
            if inserted:
                stats = await conn.fetchrow(
                    """
                    SELECT
                      (SELECT count(*) FROM message m WHERE m.conversation_id=$1 AND m.direction='in')  AS ins,
                      (SELECT count(*) FROM message m WHERE m.conversation_id=$1 AND m.direction='out') AS outs
                    """,
                    conv_id,
                )
                only_in  = stats["ins"]  > 0 and stats["outs"] == 0
                only_out = stats["outs"] > 0 and stats["ins"]  == 0

                if only_in and stats["ins"] < 10:
                    sibling_row = await conn.fetchrow(
                        """
                        SELECT c.id
                        FROM conversation c
                        WHERE c.casa_id = $1 AND c.id != $2 AND c.wa_number_id = $3
                          AND c.last_message_at > now() - interval '6 hours'
                          AND NOT EXISTS (SELECT 1 FROM message m WHERE m.conversation_id=c.id AND m.direction='in')
                          AND EXISTS     (SELECT 1 FROM message m WHERE m.conversation_id=c.id AND m.direction='out')
                        ORDER BY c.last_message_at DESC
                        LIMIT 1
                        """,
                        casa_id, conv_id, wa_number_id,
                    )
                    sibling_id = sibling_row["id"] if sibling_row else None
                elif only_out and stats["outs"] < 10:
                    sibling_row = await conn.fetchrow(
                        """
                        SELECT c.id
                        FROM conversation c
                        WHERE c.casa_id = $1 AND c.id != $2 AND c.wa_number_id = $3
                          AND c.last_message_at > now() - interval '6 hours'
                          AND EXISTS     (SELECT 1 FROM message m WHERE m.conversation_id=c.id AND m.direction='in')
                          AND NOT EXISTS (SELECT 1 FROM message m WHERE m.conversation_id=c.id AND m.direction='out')
                        ORDER BY c.last_message_at DESC
                        LIMIT 1
                        """,
                        casa_id, conv_id, wa_number_id,
                    )
                    sibling_id = sibling_row["id"] if sibling_row else None

                if sibling_id is not None:
                    # Idempotent suggestion alert — kept as a safety net even
                    # when the auto-merge job runs.
                    already = await conn.fetchval(
                        """
                        SELECT 1 FROM alert
                        WHERE type='merge_suggestion' AND conversation_id=$1
                          AND acknowledged_at IS NULL
                        LIMIT 1
                        """,
                        conv_id,
                    )
                    if not already:
                        await conn.execute(
                            """
                            INSERT INTO alert (type, severity, inbox_id, conversation_id, message)
                            VALUES ('merge_suggestion', 'info', $1, $2, $3)
                            """,
                            casa_id, conv_id,
                            f"Posible duplicado: conv {conv_id} y conv {sibling_id} parecen el mismo cliente. Auto-merge en curso.",
                        )

    # Outside the DB transaction, enqueue the auto-merge job. Skipping this
    # inside `async with conn.transaction()` keeps the webhook fast — the job
    # may take 1-2s for the Claude call. Below the threshold the job leaves
    # the suggestion in place; otherwise it merges and acknowledges the alert.
    if sibling_id is not None and arq is not None:
        try:
            await arq.enqueue_job(
                "auto_merge_job",
                int(conv_id), int(sibling_id),
                _defer_by=2,  # let any racing inserts settle
            )
        except Exception:
            logger.warning("auto_merge enqueue failed conv=%s sib=%s", conv_id, sibling_id, exc_info=True)


async def _handle_message_ack(db: KpiDB, data: dict[str, Any]) -> None:
    msg_id = data.get("id")
    ack = data.get("ack")
    if not msg_id or ack is None:
        return
    async with db.acquire() as conn:
        await conn.execute(
            "UPDATE message SET ack = $2 WHERE waha_msg_id = $1",
            msg_id, int(ack),
        )
