"""SQL queries — all run against the KPI DB (single source of truth).

After the Chatwoot removal, the inbox data lives in our own tables:
  casa, contact, conversation, message (migration 0003).

Naming compatibility: `analysis.account_id` and `alert.inbox_id` columns
remain but now hold `casa.id` values. Internally we refer to `casa_id`.
"""

from __future__ import annotations

import json as _json
from dataclasses import dataclass
from datetime import date, datetime

import asyncpg

from app.models import DashboardKpis


# ═══════════════════════════════════════════════════════════════════
# Dashboard global KPIs
# ═══════════════════════════════════════════════════════════════════

async def get_dashboard_kpis(kpi_pool: asyncpg.Pool) -> DashboardKpis:
    today = date.today()

    async with kpi_pool.acquire() as conn:
        conv_count = await conn.fetchval(
            "SELECT count(*) FROM conversation WHERE created_at::date = $1",
            today,
        ) or 0
        msg_count = await conn.fetchval(
            "SELECT count(*) FROM message WHERE created_at::date = $1",
            today,
        ) or 0
        # Avg response time (seconds): for each conversation, first outgoing
        # message timestamp minus first incoming, averaged over conversations
        # touched today.
        avg_rt_seconds = await conn.fetchval(
            """
            WITH pairs AS (
                SELECT
                    c.id,
                    (SELECT min(created_at) FROM message m
                     WHERE m.conversation_id = c.id AND m.direction='in')  AS first_in,
                    (SELECT min(created_at) FROM message m
                     WHERE m.conversation_id = c.id AND m.direction='out') AS first_out
                FROM conversation c
                WHERE c.last_message_at::date = $1
            )
            SELECT avg(extract(epoch from (first_out - first_in)))::int
            FROM pairs
            WHERE first_in IS NOT NULL AND first_out IS NOT NULL AND first_out > first_in
            """,
            today,
        )

        total_casas = await conn.fetchval("SELECT count(*) FROM casa") or 0
        online_casas = await conn.fetchval(
            """
            SELECT count(DISTINCT c.casa_id) FROM conversation c
            JOIN message m ON m.conversation_id = c.id
            WHERE m.created_at > now() - interval '24 hours'
            """,
        ) or 0

        active_alerts = await conn.fetchval(
            "SELECT count(*) FROM alert WHERE acknowledged_at IS NULL"
        ) or 0
        avg_conv = await conn.fetchval(
            "SELECT avg(conv_probability)::float FROM analysis WHERE analyzed_at::date = $1",
            today,
        )

    return DashboardKpis(
        total_conversations_today=conv_count,
        total_messages_today=msg_count,
        avg_response_time_min=round((avg_rt_seconds or 0) / 60, 1),
        avg_conversion_rate=round((avg_conv or 0.0) * 100, 1),
        active_alerts=active_alerts,
        online_instances=online_casas,
        total_instances=total_casas,
    )


# ═══════════════════════════════════════════════════════════════════
# Heatmap
# ═══════════════════════════════════════════════════════════════════

async def get_heatmap_last_7_days(kpi_pool: asyncpg.Pool) -> list[list[int]]:
    """7×24 grid [Monday..Sunday][hour] of message counts."""
    async with kpi_pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT
                extract(dow  from created_at)::int AS dow,
                extract(hour from created_at)::int AS hour,
                count(*)                            AS n
            FROM message
            WHERE created_at > now() - interval '7 days'
            GROUP BY dow, hour
            """
        )
    grid = [[0] * 24 for _ in range(7)]
    for r in rows:
        monday_index = (r["dow"] + 6) % 7
        grid[monday_index][r["hour"]] = r["n"]
    return grid


# ═══════════════════════════════════════════════════════════════════
# Casas
# ═══════════════════════════════════════════════════════════════════

@dataclass(frozen=True)
class CasaSummary:
    account_id: int  # = casa.id (name kept for template compat)
    name: str
    conversations_today: int
    inboxes_total: int
    inboxes_online: int


async def list_casas(kpi_pool: asyncpg.Pool) -> list[CasaSummary]:
    async with kpi_pool.acquire() as conn:
        rows = await conn.fetch(
            """
            WITH today AS (
                SELECT casa_id, count(*) AS n
                FROM conversation
                WHERE created_at::date = current_date
                GROUP BY casa_id
            ),
            wa_totals AS (
                SELECT casa_id, count(*) AS n FROM wa_number GROUP BY casa_id
            ),
            wa_online AS (
                SELECT casa_id, count(*) AS n FROM wa_number
                WHERE phone IS NOT NULL GROUP BY casa_id
            )
            SELECT
                casa.id                      AS account_id,
                casa.name                    AS name,
                coalesce(today.n, 0)         AS conversations_today,
                coalesce(wa_totals.n, 0)     AS inboxes_total,
                coalesce(wa_online.n, 0)     AS inboxes_online
            FROM casa
            LEFT JOIN today     ON today.casa_id     = casa.id
            LEFT JOIN wa_totals ON wa_totals.casa_id = casa.id
            LEFT JOIN wa_online ON wa_online.casa_id = casa.id
            ORDER BY conversations_today DESC, casa.name ASC
            """
        )
    return [CasaSummary(**dict(r)) for r in rows]


@dataclass(frozen=True)
class WaNumber:
    id: int
    casa_id: int
    session: str
    label: str
    phone: str | None


async def list_wa_numbers_for_casa(
    kpi_pool: asyncpg.Pool, casa_id: int
) -> list[WaNumber]:
    async with kpi_pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, casa_id, session, label, phone FROM wa_number "
            "WHERE casa_id = $1 ORDER BY created_at ASC",
            casa_id,
        )
    return [WaNumber(**dict(r)) for r in rows]


async def list_all_wa_numbers(kpi_pool: asyncpg.Pool) -> list[WaNumber]:
    async with kpi_pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, casa_id, session, label, phone FROM wa_number "
            "ORDER BY casa_id, created_at ASC"
        )
    return [WaNumber(**dict(r)) for r in rows]


@dataclass(frozen=True)
class CasaHeader:
    id: int
    name: str
    convs_today: int
    inboxes_total: int
    inboxes_online: int
    alerts_active: int


async def get_casa_header(
    kpi: asyncpg.Pool, casa_id: int, casa_name: str
) -> CasaHeader:
    today = date.today()
    async with kpi.acquire() as conn:
        convs_today = await conn.fetchval(
            "SELECT count(*) FROM conversation WHERE casa_id = $1 AND created_at::date = $2",
            casa_id, today,
        ) or 0
        online = await conn.fetchval(
            """
            SELECT CASE WHEN count(*) > 0 THEN 1 ELSE 0 END
            FROM message m
            JOIN conversation c ON c.id = m.conversation_id
            WHERE c.casa_id = $1 AND m.created_at > now() - interval '24 hours'
            """,
            casa_id,
        ) or 0
        alerts_active = await conn.fetchval(
            "SELECT count(*) FROM alert WHERE inbox_id = $1 AND acknowledged_at IS NULL",
            casa_id,
        ) or 0

    return CasaHeader(
        id=casa_id,
        name=casa_name,
        convs_today=convs_today,
        inboxes_total=1,
        inboxes_online=online,
        alerts_active=alerts_active,
    )


# ═══════════════════════════════════════════════════════════════════
# Conversations
# ═══════════════════════════════════════════════════════════════════

@dataclass(frozen=True)
class ConversationRow:
    id: int
    account_id: int
    account_name: str
    inbox_id: int
    inbox_name: str
    contact_name: str | None
    contact_phone: str | None
    status: str
    message_count: int
    last_message_at: datetime
    last_message_preview: str | None
    mood_label: str | None
    mood_score: int | None
    conv_probability: float | None
    unread_count: int
    wa_number_id: int | None
    wa_label: str | None


async def list_conversations(
    kpi_pool: asyncpg.Pool,
    *,
    casa_id: int | None = None,
    wa_number_id: int | None = None,
    mood: str | None = None,
    search: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[ConversationRow], int]:
    where: list[str] = []
    params: list = []

    if casa_id is not None:
        params.append(casa_id)
        where.append(f"c.casa_id = ${len(params)}")
    if wa_number_id is not None:
        params.append(wa_number_id)
        where.append(f"c.wa_number_id = ${len(params)}")
    if search:
        params.append(f"%{search.lower()}%")
        where.append(f"(lower(ct.name) LIKE ${len(params)} OR ct.phone LIKE ${len(params)})")
    if mood:
        params.append(mood)
        where.append(f"a.mood_label = ${len(params)}")

    where_sql = ("WHERE " + " AND ".join(where)) if where else ""

    async with kpi_pool.acquire() as conn:
        total = await conn.fetchval(
            f"""
            SELECT count(*)
            FROM conversation c
            JOIN contact ct ON ct.id = c.contact_id
            LEFT JOIN analysis a ON a.conversation_id = c.id
            {where_sql}
            """,
            *params,
        ) or 0

        params_with_page = params + [limit, offset]
        rows = await conn.fetch(
            f"""
            SELECT
                c.id,
                c.casa_id             AS account_id,
                casa.name             AS account_name,
                c.status,
                c.unread_count,
                c.wa_number_id,
                wn.label              AS wa_label,
                ct.name               AS contact_name,
                ct.phone              AS contact_phone,
                c.last_message_at,
                (SELECT count(*) FROM message m WHERE m.conversation_id = c.id) AS message_count,
                (SELECT body FROM message m WHERE m.conversation_id = c.id
                 ORDER BY m.created_at DESC LIMIT 1) AS last_message_preview,
                a.mood_label, a.mood_score, a.conv_probability
            FROM conversation c
            JOIN casa ON casa.id = c.casa_id
            JOIN contact ct ON ct.id = c.contact_id
            LEFT JOIN wa_number wn ON wn.id = c.wa_number_id
            LEFT JOIN analysis a ON a.conversation_id = c.id
            {where_sql}
            ORDER BY c.last_message_at DESC NULLS LAST
            LIMIT ${len(params_with_page) - 1} OFFSET ${len(params_with_page)}
            """,
            *params_with_page,
        )

    result: list[ConversationRow] = []
    for r in rows:
        result.append(
            ConversationRow(
                id=r["id"],
                account_id=r["account_id"],
                account_name=r["account_name"],
                inbox_id=r["wa_number_id"] or r["account_id"],
                inbox_name=r["wa_label"] or r["account_name"],
                wa_number_id=r["wa_number_id"],
                wa_label=r["wa_label"],
                contact_name=r["contact_name"],
                contact_phone=r["contact_phone"],
                status=r["status"],
                message_count=r["message_count"] or 0,
                last_message_at=r["last_message_at"] or datetime.now(),
                last_message_preview=(r["last_message_preview"] or "")[:120],
                mood_label=r["mood_label"],
                mood_score=r["mood_score"],
                conv_probability=float(r["conv_probability"]) if r["conv_probability"] is not None else None,
                unread_count=r["unread_count"] or 0,
            )
        )
    return result, total


@dataclass(frozen=True)
class RecentConversation:
    id: int
    account_id: int
    account_name: str
    inbox_id: int
    contact_name: str | None
    last_message_at: datetime
    mood_label: str | None
    mood_score: int | None


async def list_recent_conversations(
    kpi_pool: asyncpg.Pool,
    limit: int = 20,
) -> list[RecentConversation]:
    async with kpi_pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT
                c.id,
                c.casa_id                 AS account_id,
                casa.name                 AS account_name,
                ct.name                   AS contact_name,
                c.last_message_at,
                a.mood_label, a.mood_score
            FROM conversation c
            JOIN casa ON casa.id = c.casa_id
            JOIN contact ct ON ct.id = c.contact_id
            LEFT JOIN analysis a ON a.conversation_id = c.id
            ORDER BY c.last_message_at DESC NULLS LAST
            LIMIT $1
            """,
            limit,
        )
    return [
        RecentConversation(
            id=r["id"],
            account_id=r["account_id"],
            account_name=r["account_name"],
            inbox_id=r["account_id"],
            contact_name=r["contact_name"],
            last_message_at=r["last_message_at"] or datetime.now(),
            mood_label=r["mood_label"],
            mood_score=r["mood_score"],
        )
        for r in rows
    ]


# Full conversation with messages (for detail view)
@dataclass(frozen=True)
class ConversationDetail:
    id: int
    casa_id: int
    casa_name: str
    waha_session: str
    wa_label: str | None
    contact_id: int
    contact_jid: str
    contact_name: str | None
    contact_phone: str | None
    status: str
    created_at: datetime


@dataclass(frozen=True)
class MessageRow:
    id: int
    direction: str
    body: str | None
    media_url: str | None
    media_mime: str | None
    ack: int
    created_at: datetime


async def get_conversation_detail(
    kpi: asyncpg.Pool, conv_id: int
) -> ConversationDetail | None:
    async with kpi.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT c.id, c.casa_id, casa.name AS casa_name,
                   coalesce(wn.session, casa.waha_session) AS waha_session,
                   wn.label AS wa_label,
                   c.contact_id,
                   ct.waha_jid, ct.name AS contact_name, ct.phone AS contact_phone,
                   c.status, c.created_at
            FROM conversation c
            JOIN casa ON casa.id = c.casa_id
            JOIN contact ct ON ct.id = c.contact_id
            LEFT JOIN wa_number wn ON wn.id = c.wa_number_id
            WHERE c.id = $1
            """,
            conv_id,
        )
    if not row:
        return None
    return ConversationDetail(
        id=row["id"], casa_id=row["casa_id"], casa_name=row["casa_name"],
        waha_session=row["waha_session"], wa_label=row["wa_label"],
        contact_id=row["contact_id"], contact_jid=row["waha_jid"],
        contact_name=row["contact_name"], contact_phone=row["contact_phone"],
        status=row["status"], created_at=row["created_at"],
    )


async def list_messages_for_conversation(
    kpi: asyncpg.Pool, conv_id: int, limit: int = 500
) -> list[MessageRow]:
    async with kpi.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, direction, body, media_url, media_mime, ack, created_at
            FROM message
            WHERE conversation_id = $1
            ORDER BY created_at ASC
            LIMIT $2
            """,
            conv_id, limit,
        )
    return [MessageRow(**dict(r)) for r in rows]


async def clear_unread(kpi: asyncpg.Pool, conv_id: int) -> None:
    async with kpi.acquire() as conn:
        await conn.execute(
            "UPDATE conversation SET unread_count = 0 WHERE id = $1",
            conv_id,
        )


async def set_conversation_status(
    kpi: asyncpg.Pool, conv_id: int, status: str
) -> None:
    async with kpi.acquire() as conn:
        await conn.execute(
            "UPDATE conversation SET status = $2, updated_at = now() WHERE id = $1",
            conv_id, status,
        )


# ═══════════════════════════════════════════════════════════════════
# Metricas / trends (unchanged — still read from analysis)
# ═══════════════════════════════════════════════════════════════════

@dataclass(frozen=True)
class MetricaWithDelta:
    value: float
    previous: float
    delta_pct: float | None


@dataclass(frozen=True)
class CasaMetricas:
    convs_count: MetricaWithDelta
    avg_response_time_seconds: MetricaWithDelta
    avg_conv_probability: MetricaWithDelta
    mood_distribution: dict[str, int]
    avg_treat: dict[str, float]
    red_flags_count: int


async def get_casa_metricas(
    kpi: asyncpg.Pool, casa_id: int, days: int = 30
) -> CasaMetricas:
    async with kpi.acquire() as conn:
        cur = await conn.fetchrow(
            """
            SELECT
                count(*)                                        AS n,
                avg(rt_p50)::float                              AS avg_rt,
                avg(conv_probability)::float                    AS avg_conv,
                avg(treat_carinoso)::float                      AS carinoso,
                avg(treat_profesional)::float                   AS profesional,
                avg(treat_vendedor)::float                      AS vendedor,
                avg(treat_seco)::float                          AS seco,
                sum(jsonb_array_length(red_flags))::int         AS red_flags
            FROM analysis
            WHERE account_id = $1
              AND analyzed_at > now() - make_interval(days => $2)
            """,
            casa_id, days,
        )
        prev = await conn.fetchrow(
            """
            SELECT
                count(*)                        AS n,
                avg(rt_p50)::float              AS avg_rt,
                avg(conv_probability)::float    AS avg_conv
            FROM analysis
            WHERE account_id = $1
              AND analyzed_at > now() - make_interval(days => $2)
              AND analyzed_at <= now() - make_interval(days => $3)
            """,
            casa_id, days * 2, days,
        )
        mood_rows = await conn.fetch(
            """
            SELECT mood_label, count(*) AS n
            FROM analysis
            WHERE account_id = $1
              AND analyzed_at > now() - make_interval(days => $2)
            GROUP BY mood_label
            """,
            casa_id, days,
        )

    def _delta(cur_v, prev_v) -> MetricaWithDelta:
        cur_f = float(cur_v or 0)
        prev_f = float(prev_v or 0)
        pct = None
        if prev_f > 0:
            pct = round((cur_f - prev_f) / prev_f * 100, 1)
        return MetricaWithDelta(value=cur_f, previous=prev_f, delta_pct=pct)

    return CasaMetricas(
        convs_count=_delta(cur["n"], prev["n"] if prev else 0),
        avg_response_time_seconds=_delta(
            (cur["avg_rt"] or 0) / 1000 if cur["avg_rt"] else 0,
            (prev["avg_rt"] or 0) / 1000 if prev and prev["avg_rt"] else 0,
        ),
        avg_conv_probability=_delta(
            (cur["avg_conv"] or 0) * 100,
            (prev["avg_conv"] or 0) * 100 if prev else 0,
        ),
        mood_distribution={r["mood_label"]: r["n"] for r in mood_rows},
        avg_treat={
            "carinoso": round(cur["carinoso"] or 0, 1),
            "profesional": round(cur["profesional"] or 0, 1),
            "vendedor": round(cur["vendedor"] or 0, 1),
            "seco": round(cur["seco"] or 0, 1),
        },
        red_flags_count=cur["red_flags"] or 0,
    )


@dataclass(frozen=True)
class DailyPoint:
    day: date
    count: int
    avg_mood_score: float | None
    avg_conv: float | None


async def get_casa_daily_trend(
    kpi: asyncpg.Pool, casa_id: int, days: int = 30
) -> list[DailyPoint]:
    async with kpi.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT
                analyzed_at::date                 AS day,
                count(*)                          AS n,
                avg(mood_score)::float            AS avg_mood,
                avg(conv_probability)::float      AS avg_conv
            FROM analysis
            WHERE account_id = $1
              AND analyzed_at > now() - make_interval(days => $2)
            GROUP BY analyzed_at::date
            ORDER BY analyzed_at::date ASC
            """,
            casa_id, days,
        )
    return [
        DailyPoint(
            day=r["day"], count=r["n"],
            avg_mood_score=round(r["avg_mood"], 1) if r["avg_mood"] else None,
            avg_conv=round(r["avg_conv"], 2) if r["avg_conv"] else None,
        )
        for r in rows
    ]


@dataclass(frozen=True)
class TopBottomConv:
    id: int
    contact_name: str | None
    conv_probability: float
    mood_label: str
    analyzed_at: datetime


async def get_casa_top_bottom_convs(
    kpi: asyncpg.Pool, casa_id: int, limit: int = 5
) -> tuple[list[TopBottomConv], list[TopBottomConv]]:
    """Top + bottom by conv_probability. Contact name joined via conversation→contact."""
    async with kpi.acquire() as conn:
        top_rows = await conn.fetch(
            """
            SELECT a.conversation_id, a.conv_probability, a.mood_label, a.analyzed_at,
                   ct.name AS contact_name
            FROM analysis a
            LEFT JOIN conversation c ON c.id = a.conversation_id
            LEFT JOIN contact ct ON ct.id = c.contact_id
            WHERE a.account_id = $1
            ORDER BY a.conv_probability DESC
            LIMIT $2
            """,
            casa_id, limit,
        )
        bottom_rows = await conn.fetch(
            """
            SELECT a.conversation_id, a.conv_probability, a.mood_label, a.analyzed_at,
                   ct.name AS contact_name
            FROM analysis a
            LEFT JOIN conversation c ON c.id = a.conversation_id
            LEFT JOIN contact ct ON ct.id = c.contact_id
            WHERE a.account_id = $1
            ORDER BY a.conv_probability ASC
            LIMIT $2
            """,
            casa_id, limit,
        )

    def _mk(rows):
        return [
            TopBottomConv(
                id=r["conversation_id"],
                contact_name=r["contact_name"],
                conv_probability=float(r["conv_probability"]),
                mood_label=r["mood_label"],
                analyzed_at=r["analyzed_at"],
            )
            for r in rows
        ]
    return _mk(top_rows), _mk(bottom_rows)


# ═══════════════════════════════════════════════════════════════════
# Alerts
# ═══════════════════════════════════════════════════════════════════

@dataclass(frozen=True)
class AlertRow:
    id: int
    type: str
    severity: str
    conversation_id: int | None
    inbox_id: int | None  # = casa_id
    message: str
    created_at: datetime
    acknowledged_at: datetime | None


async def get_casa_alerts(
    kpi: asyncpg.Pool, casa_id: int, days: int = 30,
    only_unack: bool = False,
) -> list[AlertRow]:
    where_ack = "AND acknowledged_at IS NULL" if only_unack else ""
    async with kpi.acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT id, type, severity, conversation_id, inbox_id, message,
                   created_at, acknowledged_at
            FROM alert
            WHERE (inbox_id = $1 OR
                   conversation_id IN (SELECT id FROM conversation WHERE casa_id = $1))
              AND created_at > now() - make_interval(days => $2)
              {where_ack}
            ORDER BY (acknowledged_at IS NULL) DESC, created_at DESC
            LIMIT 200
            """,
            casa_id, days,
        )
    return [AlertRow(**dict(r)) for r in rows]


# ═══════════════════════════════════════════════════════════════════
# Analyzer queue helpers
# ═══════════════════════════════════════════════════════════════════

async def count_analyzed_for_casa(kpi: asyncpg.Pool, casa_id: int) -> int:
    async with kpi.acquire() as conn:
        return await conn.fetchval(
            "SELECT count(*) FROM analysis WHERE account_id = $1",
            casa_id,
        ) or 0


async def count_unanalyzed_for_casa(kpi: asyncpg.Pool, casa_id: int) -> int:
    """Resolved conversations NOT yet in analysis table."""
    async with kpi.acquire() as conn:
        return await conn.fetchval(
            """
            SELECT count(*) FROM conversation c
            WHERE c.casa_id = $1 AND c.status = 'resolved'
              AND NOT EXISTS (SELECT 1 FROM analysis a WHERE a.conversation_id = c.id)
            """,
            casa_id,
        ) or 0


async def list_unanalyzed_conversation_ids(
    kpi: asyncpg.Pool, casa_id: int, limit: int = 500,
) -> list[int]:
    async with kpi.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT c.id FROM conversation c
            WHERE c.casa_id = $1 AND c.status = 'resolved'
              AND NOT EXISTS (SELECT 1 FROM analysis a WHERE a.conversation_id = c.id)
            ORDER BY c.updated_at DESC
            LIMIT $2
            """,
            casa_id, limit,
        )
    return [r["id"] for r in rows]


# ═══════════════════════════════════════════════════════════════════
# Meta-analysis
# ═══════════════════════════════════════════════════════════════════

@dataclass(frozen=True)
class CasaMetaAnalysis:
    id: int
    account_id: int
    run_at: datetime
    conversations_analyzed: int
    summary: str
    patterns: list
    strengths: list
    improvements: list
    client_profile: str


async def get_latest_meta_analysis(
    kpi: asyncpg.Pool, casa_id: int
) -> CasaMetaAnalysis | None:
    async with kpi.acquire() as conn:
        exists = await conn.fetchval("SELECT to_regclass('public.casa_meta_analysis')")
        if not exists:
            return None
        row = await conn.fetchrow(
            """
            SELECT id, account_id, run_at, conversations_analyzed,
                   summary, patterns, strengths, improvements, client_profile
            FROM casa_meta_analysis
            WHERE account_id = $1
            ORDER BY run_at DESC LIMIT 1
            """,
            casa_id,
        )
    if not row:
        return None
    return CasaMetaAnalysis(
        id=row["id"], account_id=row["account_id"], run_at=row["run_at"],
        conversations_analyzed=row["conversations_analyzed"],
        summary=row["summary"],
        patterns=_json.loads(row["patterns"]) if isinstance(row["patterns"], str) else row["patterns"],
        strengths=_json.loads(row["strengths"]) if isinstance(row["strengths"], str) else row["strengths"],
        improvements=_json.loads(row["improvements"]) if isinstance(row["improvements"], str) else row["improvements"],
        client_profile=row["client_profile"],
    )


async def list_meta_analyses(
    kpi: asyncpg.Pool, casa_id: int, days: int = 30, limit: int = 10,
    wa_number_id: int | None = None,
) -> list[CasaMetaAnalysis]:
    async with kpi.acquire() as conn:
        exists = await conn.fetchval("SELECT to_regclass('public.casa_meta_analysis')")
        if not exists:
            return []
        wa_filter = "AND wa_number_id = $4" if wa_number_id is not None else ""
        params: list = [casa_id, days, limit]
        if wa_number_id is not None:
            params.append(wa_number_id)
        rows = await conn.fetch(
            f"""
            SELECT id, account_id, run_at, conversations_analyzed,
                   summary, patterns, strengths, improvements, client_profile
            FROM casa_meta_analysis
            WHERE account_id = $1
              AND run_at > now() - make_interval(days => $2)
              {wa_filter}
            ORDER BY run_at DESC LIMIT $3
            """,
            *params,
        )
    return [
        CasaMetaAnalysis(
            id=r["id"], account_id=r["account_id"], run_at=r["run_at"],
            conversations_analyzed=r["conversations_analyzed"],
            summary=r["summary"],
            patterns=_json.loads(r["patterns"]) if isinstance(r["patterns"], str) else r["patterns"],
            strengths=_json.loads(r["strengths"]) if isinstance(r["strengths"], str) else r["strengths"],
            improvements=_json.loads(r["improvements"]) if isinstance(r["improvements"], str) else r["improvements"],
            client_profile=r["client_profile"],
        )
        for r in rows
    ]


# ═══════════════════════════════════════════════════════════════════
# Individual analysis history (per-casa, per-wa filterable)
# ═══════════════════════════════════════════════════════════════════

@dataclass(frozen=True)
class AnalysisHistoryRow:
    conversation_id: int
    analyzed_at: datetime
    wa_number_id: int | None
    wa_label: str | None
    contact_name: str | None
    contact_phone: str | None
    mood_label: str
    mood_score: int
    conv_probability: float
    rt_p50_ms: int
    red_flags_count: int


async def list_analysis_history(
    kpi: asyncpg.Pool,
    casa_id: int,
    *,
    wa_number_id: int | None = None,
    limit: int = 100,
    offset: int = 0,
) -> tuple[list[AnalysisHistoryRow], int]:
    """Flat history of individual analyses for a casa, filterable by WA."""
    where = ["a.account_id = $1"]
    params: list = [casa_id]
    if wa_number_id is not None:
        params.append(wa_number_id)
        where.append(f"a.wa_number_id = ${len(params)}")
    where_sql = " AND ".join(where)

    async with kpi.acquire() as conn:
        total = await conn.fetchval(
            f"SELECT count(*) FROM analysis a WHERE {where_sql}",
            *params,
        ) or 0

        params_with_page = params + [limit, offset]
        rows = await conn.fetch(
            f"""
            SELECT
                a.conversation_id, a.analyzed_at, a.wa_number_id,
                wn.label  AS wa_label,
                ct.name   AS contact_name,
                ct.phone  AS contact_phone,
                a.mood_label, a.mood_score, a.conv_probability,
                a.rt_p50,
                COALESCE(jsonb_array_length(a.red_flags), 0) AS red_flags_count
            FROM analysis a
            LEFT JOIN conversation c ON c.id = a.conversation_id
            LEFT JOIN contact ct    ON ct.id = c.contact_id
            LEFT JOIN wa_number wn  ON wn.id = a.wa_number_id
            WHERE {where_sql}
            ORDER BY a.analyzed_at DESC
            LIMIT ${len(params_with_page) - 1} OFFSET ${len(params_with_page)}
            """,
            *params_with_page,
        )
    return [
        AnalysisHistoryRow(
            conversation_id=r["conversation_id"],
            analyzed_at=r["analyzed_at"],
            wa_number_id=r["wa_number_id"],
            wa_label=r["wa_label"],
            contact_name=r["contact_name"],
            contact_phone=r["contact_phone"],
            mood_label=r["mood_label"],
            mood_score=r["mood_score"],
            conv_probability=float(r["conv_probability"]),
            rt_p50_ms=r["rt_p50"],
            red_flags_count=r["red_flags_count"] or 0,
        )
        for r in rows
    ], total

