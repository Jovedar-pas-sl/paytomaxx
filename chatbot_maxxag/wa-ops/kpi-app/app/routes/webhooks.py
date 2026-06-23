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
import re
import json
import logging
import math
import time
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response, status

from app import queries
from app.deps import Arq, KpiDB
from app.settings import get_settings

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/webhook")

# Auto-reply burst debounce (seconds): rapid messages from one client collapse
# into a single deferred job (see the enqueue gate in _handle_message).
_AUTOREPLY_DEBOUNCE_S = 8

# Valid WGS-84 coordinate ranges — used to reject garbage location payloads.
_LAT_MIN, _LAT_MAX = -90.0, 90.0
_LNG_MIN, _LNG_MAX = -180.0, 180.0


def _coerce_coord(lat: object, lng: object) -> tuple[float, float] | None:
    """Coerce a (lat, lng) pair to finite, in-range floats, or None.

    Input-validation at the boundary: returns None unless BOTH coerce to finite
    floats AND fall inside the valid WGS-84 ranges. Never raises.
    """
    try:
        flat = float(lat)  # type: ignore[arg-type]
        flng = float(lng)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if not (math.isfinite(flat) and math.isfinite(flng)):
        return None
    if not (_LAT_MIN <= flat <= _LAT_MAX and _LNG_MIN <= flng <= _LNG_MAX):
        return None
    return (flat, flng)


def _extract_location(data: dict[str, Any], _d: dict[str, Any]) -> tuple[float, float] | None:
    """Defensively extract a (lat, lng) from a WAHA NOWEB message payload.

    WAHA does NOT publish a canonical incoming-location example and the exact
    field path varies by engine/version, so we try several known shapes in order
    and take the FIRST that yields a valid coordinate pair:

      1. payload.location.{latitude,longitude}            (WAHA normalized, newer)
      2. _data.message.locationMessage.{degreesLatitude,  (Baileys raw proto —
         degreesLongitude}                                 NOWEB primary)
      3. _data.location.{degreesLatitude,degreesLongitude} (NOWEB alt nesting)
      4. payload.lat / _data.lat  +  payload.lng / _data.lng (flat fallback)

    Returns None for a non-location message (the common case) or any unrecognized
    shape. Never raises (keeps the webhook crash-proof per CLAUDE.md). Logs once
    when a location-looking message arrives but no path matched, so a new WAHA
    shape can be added.
    """
    # 1) WAHA normalized top-level location object.
    loc = data.get("location")
    if isinstance(loc, dict):
        coord = _coerce_coord(loc.get("latitude"), loc.get("longitude"))
        if coord is not None:
            return coord

    # 2) Baileys raw proto: _data.message.locationMessage.
    msg = _d.get("message")
    loc_msg = msg.get("locationMessage") if isinstance(msg, dict) else None
    if isinstance(loc_msg, dict):
        coord = _coerce_coord(
            loc_msg.get("degreesLatitude"), loc_msg.get("degreesLongitude")
        )
        if coord is not None:
            return coord

    # 3) NOWEB alt nesting: _data.location.{degreesLatitude,...}.
    d_loc = _d.get("location")
    if isinstance(d_loc, dict):
        coord = _coerce_coord(
            d_loc.get("degreesLatitude") or d_loc.get("latitude"),
            d_loc.get("degreesLongitude") or d_loc.get("longitude"),
        )
        if coord is not None:
            return coord

    # 4) Flat fallback on either dict.
    coord = _coerce_coord(
        data.get("lat") if data.get("lat") is not None else _d.get("lat"),
        data.get("lng") if data.get("lng") is not None else _d.get("lng"),
    )
    if coord is not None:
        return coord

    # If the message *looks* like a location but no path matched, log the shape
    # so we can extend the extractor (don't raise — just skip the capture).
    looks_like_location = (
        data.get("type") == "location"
        or loc is not None
        or loc_msg is not None
        or d_loc is not None
    )
    if looks_like_location:
        logger.warning(
            "waha location in unrecognized shape — coords not captured: %s",
            str({"type": data.get("type"), "location": loc, "_data_keys": list(_d.keys())})[:300],
        )
    return None


_SESSION_MAX_LEN = 64
_SESSION_RE = re.compile(r"[^A-Za-z0-9_.\-]")


def _sanitize_session(value: object) -> str | None:
    """Charset+length guard for a WAHA session id (it ends up in WAHA API paths).

    Strips anything outside [A-Za-z0-9_.-], hard-truncates to _SESSION_MAX_LEN,
    and returns None for non-str or all-invalid input (caller ignores the event).
    """
    if not isinstance(value, str):
        return None
    cleaned = _SESSION_RE.sub("", value)[:_SESSION_MAX_LEN]
    return cleaned or None


def _verify_hmac(body: bytes, header_sig: str | None) -> bool:
    """Constant-time HMAC verification, FAIL-CLOSED.

    An unset/blank secret REJECTS in production (settings.debug False) so the
    webhook is never unauthenticated on a real deployment. The empty-secret
    bypass is allowed ONLY when settings.debug is True (local development).
    """
    settings = get_settings()
    secret = settings.waha_webhook_hmac.get_secret_value() if settings.waha_webhook_hmac else ""
    if not secret.strip():
        return bool(getattr(settings, "debug", False))  # dev-only bypass
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
    session = _sanitize_session(payload.get("session")) or "default"
    data = payload.get("payload") or {}

    if event == "session.status":
        await _handle_session_status(db, session, data)
    elif event in ("message", "message.any"):
        # message.any fires for both incoming and outgoing (fromMe=true)
        await _handle_message(db, arq, session, data)
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
        # Push the operator NOW — a down session means a casa may be offline
        # (the DB alert alone isn't seen until someone logs in). Fail-soft.
        from app.notify import push_alert
        await push_alert(
            f"⚠️ WhatsApp '{session}' → {status}. Una casa puede estar offline — revisa /sessions."
        )


async def _handle_message(db: KpiDB, arq: Arq, session: str, data: dict[str, Any]) -> None:
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
        # Do NOT log raw `data` — it carries client PII (phone/JID, pushName, body).
        logger.warning(
            "waha message missing id/chat_id (from_me=%s has_media=%s)",
            from_me, has_media,
        )
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

    # F3: capture a location PIN (lat/lng) when the incoming message is a
    # WhatsApp location. Defensive across WAHA NOWEB field shapes; None for any
    # non-location message. Stored on the message row (additive on the normal
    # upsert) — the auto_reply job reads it later to compute the outcall price.
    location = _extract_location(data, _d)
    msg_lat = location[0] if location is not None else None
    msg_lng = location[1] if location is not None else None

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
                    media_url, media_mime, ack, created_at,
                    latitude, longitude
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                ON CONFLICT (waha_msg_id) DO NOTHING
                RETURNING id
                """,
                conv_id, msg_id, direction, body,
                media.get("url") if has_media else None,
                media.get("mimetype") if has_media else None,
                int(data.get("ack") or 0),
                created_at,
                msg_lat, msg_lng,
            )

            # Bump unread_count for incoming new messages
            if inserted and direction == "in":
                await conn.execute(
                    "UPDATE conversation SET unread_count = unread_count + 1 WHERE id = $1",
                    conv_id,
                )

            # Merge SUGGESTION (no auto-apply): if this conv is one-sided and
            # there's a complementary sibling in the same casa, record an alert
            # so the admin can confirm via UI (/conversation/<id>/auto-merge
            # with IA, or manual dropdown). Never touch data from the webhook.
            if inserted and direction == "in":
                stats = await conn.fetchrow(
                    """
                    SELECT
                      (SELECT count(*) FROM message m WHERE m.conversation_id=$1 AND m.direction='in')  AS ins,
                      (SELECT count(*) FROM message m WHERE m.conversation_id=$1 AND m.direction='out') AS outs
                    """,
                    conv_id,
                )
                me_only_in = stats["ins"] > 0 and stats["outs"] == 0
                if me_only_in and stats["ins"] < 10:
                    sibling = await conn.fetchrow(
                        """
                        SELECT c.id
                        FROM conversation c
                        WHERE c.casa_id = $1 AND c.id != $2 AND c.wa_number_id = $3
                          AND c.last_message_at > now() - interval '2 hours'
                          AND NOT EXISTS (SELECT 1 FROM message m WHERE m.conversation_id=c.id AND m.direction='in')
                          AND EXISTS     (SELECT 1 FROM message m WHERE m.conversation_id=c.id AND m.direction='out')
                        ORDER BY c.last_message_at DESC
                        LIMIT 1
                        """,
                        casa_id, conv_id, wa_number_id,
                    )
                    if sibling:
                        # Idempotent alert — don't spam if already suggested
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
                                f"Posible duplicado: conv {conv_id} (entrantes solo) parece el mismo cliente que conv {sibling['id']} (salientes solo). Revisa y fusiona.",
                            )

    # ── Agent auto-reply enqueue gate (F2) ──────────────────────────
    # Runs AFTER the transaction + acquire blocks above have committed, so the
    # new message row is durable before the worker can pick the job up. This is
    # a PURE ENQUEUE — never mutate or send here (CLAUDE.md rule 5). The worker
    # (auto_reply_job) re-checks mode + agent_status itself, so the pre-checks
    # below are only a cheap optimization to avoid flooding Redis with jobs for
    # the common 'off' case (most numbers are off); there is no correctness
    # dependency on them. Only new INCOMING messages can trigger a reply.
    if inserted and direction == "in":
        mode = await queries.get_wa_mode_for_conversation(db, conv_id)
        if mode != "off":
            agent_status = await queries.get_conversation_agent_status(db, conv_id)
            if agent_status in (None, "active"):
                # Coalesce message bursts into ONE reply: a per-conversation,
                # time-bucketed job id means rapid messages in the same window
                # dedup to a single deferred job (which re-reads the full
                # transcript). The bucket rotates over time so later messages
                # are never blocked by a past job's retained result.
                bucket = int(time.time()) // _AUTOREPLY_DEBOUNCE_S
                await arq.enqueue_job(
                    "auto_reply_job",
                    conv_id,
                    _job_id=f"autoreply:{conv_id}:{bucket}",
                    _defer_by=_AUTOREPLY_DEBOUNCE_S,
                )


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
