"""SQL queries — all run against the KPI DB (single source of truth).

After the Chatwoot removal, the inbox data lives in our own tables:
  casa, contact, conversation, message (migration 0003).

Naming compatibility: `analysis.account_id` and `alert.inbox_id` columns
remain but now hold `casa.id` values. Internally we refer to `casa_id`.
"""

from __future__ import annotations

import json as _json
import re
import unicodedata
from dataclasses import dataclass
from datetime import date, datetime

import asyncpg

from app.models import DashboardKpis


# ═══════════════════════════════════════════════════════════════════
# Dashboard global KPIs
# ═══════════════════════════════════════════════════════════════════

# "Lo crítico sin ver": only alerts that actually need a human NOW.
# Excludes the noise that dominated the raw count (agent_suggestion = info,
# slow_response = warning, merge_suggestion = info, unassigned_wa_session).
# Kept: only RECENT (last 48h), unacknowledged red_flag (menor/fraude) and
# escalation (admin needed). Excluded on purpose: paused_risk (a meta-alert that
# just duplicates the underlying red_flag/escalation), and ALL WhatsApp-connection
# alerts (wa_disconnected / wa_needs_qr — that status lives in "Estado casas
# online/total"). Old alerts age out after 48h so the panel stays current. Fixed
# constant — no user input — so it is safe to interpolate into the WHERE clause.
def _critical_alerts_where(alias: str = "") -> str:
    """Build the de-noised critical-alerts WHERE clause, optionally column-
    qualified (e.g. alias='a.' for joined queries). Fixed string — no user
    input — so interpolation is safe."""
    p = f"{alias}." if alias else ""
    return (
        f"{p}acknowledged_at IS NULL "
        f"AND {p}created_at > now() - interval '48 hours' "
        f"AND {p}type IN ('red_flag','escalation','sara_misbehaving')"
    )


_CRITICAL_ALERTS_WHERE = _critical_alerts_where()


async def count_critical_alerts(kpi_pool: asyncpg.Pool) -> int:
    """De-noised, actionable alert count shown on the dashboard + nav badge.

    Single source of truth for "lo crítico sin ver". The full Alertas page still
    lists everything; this only powers the headline count."""
    async with kpi_pool.acquire() as conn:
        return await conn.fetchval(
            f"SELECT count(*) FROM alert WHERE {_CRITICAL_ALERTS_WHERE}"
        ) or 0


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
        # First-response stats over conversations whose FIRST client message
        # arrived in the last 24h. For each such conversation: first inbound 'in'
        # → first subsequent outbound 'out'. We report the MEDIAN (robust to the
        # few never-answered / very-slow outliers that inflated the old mean) and
        # the % answered in under 5 minutes. A delta is timezone-agnostic, so no
        # AT TIME ZONE is needed here.
        rt_stats = await conn.fetchrow(
            """
            WITH pairs AS (
                SELECT
                    c.id,
                    (SELECT min(created_at) FROM message m
                     WHERE m.conversation_id = c.id AND m.direction='in') AS first_in
                FROM conversation c
            ),
            firsts AS (
                SELECT
                    p.id,
                    p.first_in,
                    (SELECT min(m.created_at) FROM message m
                     WHERE m.conversation_id = p.id
                       AND m.direction = 'out'
                       AND m.created_at >= p.first_in) AS first_out
                FROM pairs p
                WHERE p.first_in IS NOT NULL
                  AND p.first_in > now() - interval '24 hours'
            ),
            deltas AS (
                SELECT extract(epoch from (first_out - first_in)) AS secs
                FROM firsts
                WHERE first_out IS NOT NULL AND first_out >= first_in
            )
            SELECT
                percentile_cont(0.5) WITHIN GROUP (ORDER BY secs)::int AS median_secs,
                count(*)                                               AS answered,
                count(*) FILTER (WHERE secs < 300)                     AS under_5min
            FROM deltas
            """,
        )
        median_secs = (rt_stats["median_secs"] if rt_stats else None) or 0
        answered = (rt_stats["answered"] if rt_stats else 0) or 0
        under_5 = (rt_stats["under_5min"] if rt_stats else 0) or 0
        pct_under_5 = round(under_5 * 100.0 / answered, 0) if answered else 0.0

        total_casas = await conn.fetchval("SELECT count(*) FROM casa") or 0
        online_casas = await conn.fetchval(
            """
            SELECT count(DISTINCT c.casa_id) FROM conversation c
            JOIN message m ON m.conversation_id = c.id
            WHERE m.created_at > now() - interval '24 hours'
            """,
        ) or 0

        # De-noised critical count (PART 3) — same constant as the nav badge.
        active_alerts = await conn.fetchval(
            f"SELECT count(*) FROM alert WHERE {_CRITICAL_ALERTS_WHERE}"
        ) or 0
        avg_conv = await conn.fetchval(
            "SELECT avg(conv_probability)::float FROM analysis WHERE analyzed_at::date = $1",
            today,
        )
        # Conversations created today whose LAST message is inbound (= waiting
        # for a reply from the casa). Context sub-line for "Conversaciones hoy".
        unanswered_today = await conn.fetchval(
            """
            SELECT count(*) FROM conversation c
            WHERE c.created_at::date = $1
              AND (SELECT direction FROM message m WHERE m.conversation_id = c.id
                   ORDER BY m.created_at DESC LIMIT 1) = 'in'
            """,
            today,
        ) or 0

    return DashboardKpis(
        total_conversations_today=conv_count,
        total_messages_today=msg_count,
        median_first_response_seconds=int(median_secs),
        pct_answered_under_5min=float(pct_under_5),
        avg_response_time_min=round(int(median_secs) / 60, 1),
        avg_conversion_rate=round((avg_conv or 0.0) * 100, 1),
        unanswered_today=unanswered_today,
        active_alerts=active_alerts,
        online_instances=online_casas,
        total_instances=total_casas,
    )


@dataclass(frozen=True)
class KpiExtras:
    """Extras para las tarjetas KPI del dashboard (datos reales, no inventados)."""
    casa_name: str | None       # casa con más mensajes hoy
    casa_msgs: int              # nº de mensajes de esa casa hoy
    conv_series: list[int]      # conversaciones/día últimos 7 días (viejo→hoy)
    conv_yesterday: int         # conversaciones ayer (para el delta)


async def get_kpi_extras(kpi_pool: asyncpg.Pool) -> KpiExtras:
    async with kpi_pool.acquire() as conn:
        casa = await conn.fetchrow(
            """
            SELECT casa.name AS name, count(*) AS n
            FROM message m
            JOIN conversation c ON c.id = m.conversation_id
            JOIN casa ON casa.id = c.casa_id
            WHERE m.created_at::date = current_date
            GROUP BY casa.id, casa.name
            ORDER BY n DESC
            LIMIT 1
            """
        )
        series_rows = await conn.fetch(
            """
            SELECT (SELECT count(*) FROM conversation c
                    WHERE c.created_at::date = current_date - g) AS n
            FROM generate_series(6, 0, -1) AS g
            """
        )
    conv_series = [int(r["n"]) for r in series_rows]
    conv_yesterday = conv_series[-2] if len(conv_series) >= 2 else 0
    return KpiExtras(
        casa_name=(casa["name"] if casa else None),
        casa_msgs=(int(casa["n"]) if casa else 0),
        conv_series=conv_series,
        conv_yesterday=conv_yesterday,
    )


# ═══════════════════════════════════════════════════════════════════
# Heatmap
# ═══════════════════════════════════════════════════════════════════

async def get_heatmap_last_7_days(kpi_pool: asyncpg.Pool) -> list[list[int]]:
    """7×24 grid [Monday..Sunday][hour] of INBOUND client messages.

    Marketing view: counts only direction='in' (when CLIENTS write, not when the
    casa replies), and buckets dow/hour in Europe/Madrid so the busy windows line
    up with local clock time regardless of how created_at is stored (UTC)."""
    async with kpi_pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT
                extract(dow  from created_at AT TIME ZONE 'Europe/Madrid')::int AS dow,
                extract(hour from created_at AT TIME ZONE 'Europe/Madrid')::int AS hour,
                count(*)                                                        AS n
            FROM message
            WHERE direction = 'in'
              AND created_at > now() - interval '7 days'
            GROUP BY dow, hour
            """
        )
    grid = [[0] * 24 for _ in range(7)]
    for r in rows:
        monday_index = (r["dow"] + 6) % 7
        grid[monday_index][r["hour"]] = r["n"]
    return grid


# ═══════════════════════════════════════════════════════════════════
# Action feed ("Qué atender ahora") — dashboard top panel
# ═══════════════════════════════════════════════════════════════════
# (widget_action_feed + list_unanswered_by_casa/list_critical_alerts/list_hot_leads
#  removed: the "Qué atender ahora" panel was retired from the dashboard.)


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
    mode: str = "off"  # agent mode: off | copilot | auto (default keeps agent inert)
    conv_count: int = 0
    unread_total: int = 0
    last_activity: datetime | None = None


async def list_wa_numbers_for_casa(
    kpi_pool: asyncpg.Pool, casa_id: int
) -> list[WaNumber]:
    """Returns wa_numbers + per-WA aggregates (conv count, unread, last activity).

    Single query with LEFT JOIN to avoid N+1.
    """
    async with kpi_pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT w.id, w.casa_id, w.session, w.label, w.phone, w.mode,
                   coalesce(c.conv_count,    0)       AS conv_count,
                   coalesce(c.unread_total,  0)::int  AS unread_total,
                   c.last_activity
            FROM wa_number w
            LEFT JOIN (
                SELECT wa_number_id,
                       count(*)::int                AS conv_count,
                       coalesce(sum(unread_count), 0) AS unread_total,
                       max(last_message_at)         AS last_activity
                FROM conversation
                WHERE wa_number_id IS NOT NULL
                GROUP BY wa_number_id
            ) c ON c.wa_number_id = w.id
            WHERE w.casa_id = $1
            ORDER BY w.created_at ASC
            """,
            casa_id,
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

# Latest conv_probability at/above this threshold marks a conversation as a
# "hot lead" — surfaced with a 🔥 badge and floated to the top of the chat list.
# Single source of truth for the >= comparison done in SQL and in the template.
HOT_LEAD_THRESHOLD = 0.7


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
    # Agent state for the per-row status pill (item 1). `mode` is the wa_number's
    # agent mode ('off'/'copilot'/'auto', coalesced — NULL join → 'off').
    # `agent_status` is the conversation pause state (NULL == active; set values
    # 'active'/'paused_human'/'paused_risk').
    mode: str = "off"
    agent_status: str | None = None
    # "Quién contestó" (Slice 2B). last_dir: direction of the very last message
    # ('in' == awaiting reply, 'out' == replied). last_out_kind: who sent the last
    # OUTBOUND message — 'sara' (agent_generated) | 'agent' (a human user) | 'human'
    # (legacy/unattributed) | None (no outbound yet). last_out_agent: that user's name.
    last_dir: str | None = None
    last_out_kind: str | None = None
    last_out_agent: str | None = None


async def list_conversations(
    kpi_pool: asyncpg.Pool,
    *,
    casa_id: int | None = None,
    casa_ids: list[int] | None = None,
    wa_number_id: int | None = None,
    mood: str | None = None,
    search: str | None = None,
    status: str | None = None,
    since_days: int | None = None,
    since_hours: int | None = None,
    unanswered_only: bool = False,
    handler: str | None = None,
    order: str = "hot",
    limit: int = 50,
    offset: int = 0,
    with_counts: bool = False,
) -> tuple[list[ConversationRow], int]:
    where: list[str] = []
    params: list = []

    if casa_id is not None:
        params.append(casa_id)
        where.append(f"c.casa_id = ${len(params)}")
    if casa_ids is not None:
        # Restrict to a set of casas (agent scope). Empty list → matches nothing.
        params.append(casa_ids)
        where.append(f"c.casa_id = ANY(${len(params)}::int[])")
    if wa_number_id is not None:
        params.append(wa_number_id)
        where.append(f"c.wa_number_id = ${len(params)}")
    if search:
        params.append(f"%{search.lower()}%")
        where.append(f"(lower(ct.name) LIKE ${len(params)} OR ct.phone LIKE ${len(params)})")
    if mood:
        params.append(mood)
        where.append(f"a.mood_label = ${len(params)}")
    if status:
        params.append(status)
        where.append(f"c.status = ${len(params)}")
    if since_days is not None:
        params.append(since_days)
        where.append(f"c.last_message_at > now() - make_interval(days => ${len(params)})")
    if since_hours is not None:
        params.append(since_hours)
        where.append(f"c.last_message_at > now() - make_interval(hours => ${len(params)})")
    if unanswered_only:
        # Last message of the conversation must be from the customer (direction='in')
        where.append(
            "(SELECT direction FROM message m WHERE m.conversation_id = c.id "
            " ORDER BY m.created_at DESC LIMIT 1) = 'in'"
        )
    if handler in ("bot", "human"):
        # Filter by who sent the LAST outbound reply: 'bot' = Sara
        # (agent_generated), 'human' = a person. Conversations with no outbound
        # match neither. The TRUE/FALSE literal comes from this validated branch
        # (no user input is interpolated into the SQL).
        want = "TRUE" if handler == "bot" else "FALSE"
        where.append(
            "(SELECT m.agent_generated FROM message m WHERE m.conversation_id = c.id "
            f" AND m.direction = 'out' ORDER BY m.created_at DESC LIMIT 1) = {want}"
        )

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

        # Ordering. order="recent" → strict most-recent-first (predictable; used
        # by the chats/inbox list). order="hot" (default) → hot leads (latest
        # conv_probability >= HOT_LEAD_THRESHOLD) float to the TOP, then recent.
        # The threshold is bound as a parameter (no interpolation of user data).
        if order == "recent":
            order_sql = "ORDER BY c.last_message_at DESC NULLS LAST"
        else:
            params.append(HOT_LEAD_THRESHOLD)
            order_sql = (
                f"ORDER BY (a.conv_probability >= ${len(params)}) DESC NULLS LAST, "
                "c.last_message_at DESC NULLS LAST"
            )
        params_with_page = params + [limit, offset]
        # message_count is a per-row count(*) — only the CSV export consumes it
        # (no template/feed does). Computing it on every call (incl. the 10s
        # dashboard feed, up to 60 rows) is wasteful, so gate it behind
        # with_counts; otherwise return 0 (keeps ConversationRow.message_count int).
        count_expr = (
            "(SELECT count(*) FROM message m WHERE m.conversation_id = c.id)"
            if with_counts else "0"
        )
        rows = await conn.fetch(
            f"""
            SELECT
                c.id,
                c.casa_id             AS account_id,
                casa.name             AS account_name,
                c.status,
                c.agent_status,
                c.unread_count,
                c.wa_number_id,
                wn.label              AS wa_label,
                coalesce(wn.mode, 'off') AS mode,
                ct.name               AS contact_name,
                ct.phone              AS contact_phone,
                c.last_message_at,
                {count_expr} AS message_count,
                (SELECT body FROM message m WHERE m.conversation_id = c.id
                 ORDER BY m.created_at DESC LIMIT 1) AS last_message_preview,
                a.mood_label, a.mood_score, a.conv_probability,
                (SELECT m.direction FROM message m WHERE m.conversation_id = c.id
                 ORDER BY m.created_at DESC LIMIT 1) AS last_dir,
                (SELECT CASE WHEN m.agent_generated THEN 'sara'
                             WHEN m.sent_by_user_id IS NOT NULL THEN 'agent'
                             ELSE 'human' END
                 FROM message m WHERE m.conversation_id = c.id AND m.direction = 'out'
                 ORDER BY m.created_at DESC LIMIT 1) AS last_out_kind,
                (SELECT au.name FROM message m
                 LEFT JOIN admin_user au ON au.id = m.sent_by_user_id
                 WHERE m.conversation_id = c.id AND m.direction = 'out'
                 ORDER BY m.created_at DESC LIMIT 1) AS last_out_agent
            FROM conversation c
            JOIN casa ON casa.id = c.casa_id
            JOIN contact ct ON ct.id = c.contact_id
            LEFT JOIN wa_number wn ON wn.id = c.wa_number_id
            LEFT JOIN analysis a ON a.conversation_id = c.id
            {where_sql}
            {order_sql}
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
                mode=r["mode"] or "off",
                agent_status=r["agent_status"],
                last_dir=r["last_dir"],
                last_out_kind=r["last_out_kind"],
                last_out_agent=r["last_out_agent"],
            )
        )
    return result, total


# ═══════════════════════════════════════════════════════════════════
# Bot monitor (Slice 2D) — vigilar a Sara con datos seguros (sin prompt)
# ═══════════════════════════════════════════════════════════════════
@dataclass(frozen=True)
class BotMonitorRow:
    id: int
    casa_name: str
    contact_name: str | None
    contact_phone: str | None
    mode: str                       # off | auto | copilot
    agent_status: str | None        # None/active | paused_human | paused_risk
    agent_paused_at: datetime | None
    conv_probability: float | None
    mood_label: str | None
    next_action: str | None         # action code (translated for display)
    next_urgency: str | None
    last_sara_msg: str | None        # last agent-generated outbound (what Sara said)
    last_sara_at: datetime | None
    risk_category: str | None        # 'red_flag' | 'escalation' (category only — no verbatim)


def _risk_category(msg: str | None) -> str | None:
    """Extract the pause-reason CATEGORY from a paused_risk alert message
    (e.g. '...(red_flag)...' / '...(escalation:medium)...') without exposing
    the full free-text (which may contain client quotes / prompt logic)."""
    if not msg or "(" not in msg or ")" not in msg:
        return None
    inside = msg.split("(", 1)[1].split(")", 1)[0]
    return (inside.split(":", 1)[0] or None)


async def list_bot_monitor(kpi: asyncpg.Pool, *, limit: int = 40) -> list[BotMonitorRow]:
    """Conversations on Sara-enabled numbers (auto/copilot), paused-risk first.
    Surfaces only safe, high-level decision data — never the prompt or `why`."""
    async with kpi.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT
                c.id, casa.name AS casa_name,
                ct.name AS contact_name, ct.phone AS contact_phone,
                c.agent_status, c.agent_paused_at,
                coalesce(wn.mode, 'off') AS mode,
                a.conv_probability, a.mood_label,
                a.next_action->>'action'  AS next_action,
                a.next_action->>'urgency' AS next_urgency,
                (SELECT m.body FROM message m WHERE m.conversation_id = c.id
                   AND m.agent_generated = TRUE AND m.direction = 'out'
                   ORDER BY m.created_at DESC LIMIT 1) AS last_sara_msg,
                (SELECT m.created_at FROM message m WHERE m.conversation_id = c.id
                   AND m.agent_generated = TRUE AND m.direction = 'out'
                   ORDER BY m.created_at DESC LIMIT 1) AS last_sara_at,
                (SELECT al.message FROM alert al WHERE al.conversation_id = c.id
                   AND al.type = 'paused_risk' ORDER BY al.created_at DESC LIMIT 1) AS risk_alert_msg
            FROM conversation c
            JOIN casa ON casa.id = c.casa_id
            JOIN contact ct ON ct.id = c.contact_id
            LEFT JOIN wa_number wn ON wn.id = c.wa_number_id
            LEFT JOIN analysis a ON a.conversation_id = c.id
            WHERE coalesce(wn.mode, 'off') <> 'off'
            ORDER BY
                (c.agent_status = 'paused_risk')  DESC NULLS LAST,
                (c.agent_status = 'paused_human') DESC NULLS LAST,
                c.last_message_at DESC NULLS LAST
            LIMIT $1
            """,
            limit,
        )
    out: list[BotMonitorRow] = []
    for r in rows:
        out.append(
            BotMonitorRow(
                id=r["id"],
                casa_name=r["casa_name"],
                contact_name=r["contact_name"],
                contact_phone=r["contact_phone"],
                mode=r["mode"] or "off",
                agent_status=r["agent_status"],
                agent_paused_at=r["agent_paused_at"],
                conv_probability=float(r["conv_probability"]) if r["conv_probability"] is not None else None,
                mood_label=r["mood_label"],
                next_action=r["next_action"],
                next_urgency=r["next_urgency"],
                last_sara_msg=((r["last_sara_msg"] or "")[:140] or None),
                last_sara_at=r["last_sara_at"],
                risk_category=_risk_category(r["risk_alert_msg"]),
            )
        )
    return out


async def ack_risk_alerts(kpi: asyncpg.Pool, conv_id: int) -> None:
    """Acknowledge any open paused_risk alerts for a conversation — used when an
    operator resumes Sara from the Bot monitor (status + alert cleared together)."""
    async with kpi.acquire() as conn:
        await conn.execute(
            "UPDATE alert SET acknowledged_at = now() "
            "WHERE conversation_id = $1 AND type = 'paused_risk' AND acknowledged_at IS NULL",
            conv_id,
        )


async def delete_meta_analysis(kpi: asyncpg.Pool, informe_id: int) -> bool:
    """Borrado PERMANENTE de un informe (fila de casa_meta_analysis).
    Devuelve True si borró una fila."""
    async with kpi.acquire() as conn:
        res = await conn.execute("DELETE FROM casa_meta_analysis WHERE id = $1", informe_id)
    return res != "DELETE 0"


async def count_risk_pauses_on_number(
    kpi: asyncpg.Pool, conversation_id: int, *, window_min: int = 30
) -> tuple[int | None, int]:
    """Para el wa_number de esta conversación, cuenta cuántas conversaciones están
    en paused_risk con agent_paused_at en los últimos `window_min` minutos.
    Devuelve (wa_number_id, count). Lo usa la auto-protección: un aluvión de
    pausas-riesgo en un mismo número = Sara descontrolada."""
    async with kpi.acquire() as conn:
        row = await conn.fetchrow(
            """
            WITH n AS (SELECT wa_number_id FROM conversation WHERE id = $1)
            SELECT
                (SELECT wa_number_id FROM n) AS wa_number_id,
                (SELECT count(*) FROM conversation c
                 WHERE c.wa_number_id = (SELECT wa_number_id FROM n)
                   AND c.wa_number_id IS NOT NULL
                   AND c.agent_status = 'paused_risk'
                   AND c.agent_paused_at > now() - make_interval(mins => $2)) AS cnt
            """,
            conversation_id, window_min,
        )
    if not row:
        return None, 0
    return row["wa_number_id"], int(row["cnt"] or 0)


async def disable_wa_number_if_active(kpi: asyncpg.Pool, wa_number_id: int) -> bool:
    """Pasa el número a mode='off' SOLO si no lo estaba ya. Devuelve True si
    realmente cambió — así la auto-protección evita alertas duplicadas cuando dos
    jobs del mismo número corren a la vez (solo el primero 'gana' el cambio)."""
    async with kpi.acquire() as conn:
        res = await conn.execute(
            "UPDATE wa_number SET mode = 'off' WHERE id = $1 AND mode <> 'off'",
            wa_number_id,
        )
    return res != "UPDATE 0"


async def count_wa_modes(kpi: asyncpg.Pool) -> dict[str, int]:
    """Cuenta los números WhatsApp por modo de Sara (auto/copilot/off).
    Alimenta el indicador 'Sara · activa/apagada' del sidebar."""
    out = {"auto": 0, "copilot": 0, "off": 0}
    async with kpi.acquire() as conn:
        rows = await conn.fetch(
            "SELECT coalesce(mode, 'off') AS mode, count(*)::int AS n FROM wa_number GROUP BY 1"
        )
    for r in rows:
        out[r["mode"]] = out.get(r["mode"], 0) + int(r["n"])
    return out


async def get_sent_photo_urls(kpi: asyncpg.Pool, conversation_id: int) -> set[str]:
    """Photo media URLs already sent (outbound) in this conversation — used to
    dedup Sara's photo cards so the same girl's image is never re-sent every turn
    (a bot tell + a media-repetition ban signal)."""
    async with kpi.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT DISTINCT media_url
            FROM message
            WHERE conversation_id = $1 AND direction = 'out'
              AND media_url IS NOT NULL AND media_url <> ''
            """,
            conversation_id,
        )
    return {r["media_url"] for r in rows if r["media_url"]}


async def list_latest_meta_per_casa(kpi: asyncpg.Pool, *, days: int = 90) -> list[dict]:
    """Último informe (casa_meta_analysis) por casa dentro de `days`, con su
    kpis + top_referrals + nombre. Base de la página Métricas (agregada).
    Defensivo: si la tabla/columnas no existen, devuelve []/[]."""
    async with kpi.acquire() as conn:
        if not await conn.fetchval("SELECT to_regclass('public.casa_meta_analysis')"):
            return []
        has_topics = await _table_has_column(conn, "casa_meta_analysis", "top_topics")
        has_kpis = await _table_has_column(conn, "casa_meta_analysis", "kpis")
        topic_cols = ", m.top_referrals" if has_topics else ""
        kpis_col = ", m.kpis" if has_kpis else ""
        rows = await conn.fetch(
            f"""
            SELECT DISTINCT ON (m.account_id)
                   m.account_id, casa.name AS casa_name, m.run_at,
                   m.conversations_analyzed {topic_cols} {kpis_col}
            FROM casa_meta_analysis m
            JOIN casa ON casa.id = m.account_id
            WHERE m.run_at > now() - make_interval(days => $1)
            ORDER BY m.account_id, m.run_at DESC
            """,
            days,
        )
    out: list[dict] = []
    for r in rows:
        out.append(
            {
                "account_id": r["account_id"],
                "casa_name": r["casa_name"],
                "run_at": r["run_at"],
                "conversations_analyzed": r["conversations_analyzed"] or 0,
                "top_referrals": _parse_jsonb(r.get("top_referrals") if has_topics else None, []) or [],
                "kpis": _parse_jsonb(r.get("kpis") if has_kpis else None, {}) or {},
            }
        )
    return out


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
    # TRUE when this outbound message was sent by the Sara agent (bot), FALSE
    # when sent by a human receptionist. Always FALSE for inbound. Used to tag
    # "🤖 Sara" bubbles in the conversation view.
    agent_generated: bool = False
    # F3: WhatsApp location PIN coords (NULL for non-location messages). Kept on
    # the message row by the webhook; read by the outcall calculator.
    latitude: float | None = None
    longitude: float | None = None


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
            SELECT id, direction, body, media_url, media_mime, ack, created_at,
                   agent_generated, latitude, longitude
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

async def count_analyzed_for_casa(
    kpi: asyncpg.Pool, casa_id: int, *, wa_number_id: int | None = None,
) -> int:
    async with kpi.acquire() as conn:
        if wa_number_id is None:
            return await conn.fetchval(
                "SELECT count(*) FROM analysis WHERE account_id = $1",
                casa_id,
            ) or 0
        return await conn.fetchval(
            "SELECT count(*) FROM analysis WHERE account_id = $1 AND wa_number_id = $2",
            casa_id, wa_number_id,
        ) or 0


def _build_pending_filter(
    *,
    wa_number_id: int | None,
    since_hours: int | None,
    include_open: bool,
    redo_dirty: bool,
) -> tuple[str, list]:
    """Build the WHERE/JOIN fragments for "convs that need analyzing right now".

    Returns ``(sql_fragment, extra_params)`` where ``$1=casa_id`` is always the
    first placeholder and the fragment uses ``${i}`` for additional params.

    Logic:
      - filter by casa_id (caller binds $1)
      - optionally filter by wa_number_id
      - optionally filter to messages received in the last N hours
      - status: 'resolved' only OR all statuses
      - "needs analyzing" = no analysis row OR (redo_dirty AND analysis older
        than the conversation's last_message_at)
    """
    params: list = []
    where = ["c.casa_id = $1"]
    next_idx = 2

    if wa_number_id is not None:
        where.append(f"c.wa_number_id = ${next_idx}")
        params.append(wa_number_id)
        next_idx += 1

    if not include_open:
        where.append("c.status = 'resolved'")

    if since_hours is not None:
        where.append(f"c.last_message_at > now() - make_interval(hours => ${next_idx})")
        params.append(since_hours)
        next_idx += 1

    if redo_dirty:
        # No analysis OR analysis is stale (new messages arrived after analyzed_at).
        where.append(
            "(NOT EXISTS (SELECT 1 FROM analysis a WHERE a.conversation_id = c.id) "
            "OR EXISTS (SELECT 1 FROM analysis a WHERE a.conversation_id = c.id "
            "           AND a.analyzed_at < c.last_message_at))"
        )
    else:
        where.append("NOT EXISTS (SELECT 1 FROM analysis a WHERE a.conversation_id = c.id)")

    return " AND ".join(where), params


async def count_unanalyzed_for_casa(
    kpi: asyncpg.Pool,
    casa_id: int,
    *,
    wa_number_id: int | None = None,
    since_hours: int | None = None,
    include_open: bool = True,
    redo_dirty: bool = True,
) -> int:
    """Count conversations that still need analysis (or re-analysis).

    Defaults match the on-demand "Generar informe" flow: include open + closed,
    re-analyze dirty ones. Pass ``include_open=False, redo_dirty=False`` to get
    the legacy behaviour (resolved-only, never repeat)."""
    where, extra = _build_pending_filter(
        wa_number_id=wa_number_id, since_hours=since_hours,
        include_open=include_open, redo_dirty=redo_dirty,
    )
    async with kpi.acquire() as conn:
        return await conn.fetchval(
            f"SELECT count(*) FROM conversation c WHERE {where}",
            casa_id, *extra,
        ) or 0


async def count_unanswered_for_casa(
    kpi: asyncpg.Pool,
    casa_id: int,
    *,
    wa_number_id: int | None = None,
    since_days: int | None = None,
) -> int:
    """Count conversations whose last message is from the customer (direction='in').

    Used by the 'Sin contestar' chip in the chat tab to show how many convs
    are waiting for a reply from the mamai.
    """
    params: list = [casa_id]
    where = ["c.casa_id = $1"]
    if wa_number_id is not None:
        params.append(wa_number_id)
        where.append(f"c.wa_number_id = ${len(params)}")
    if since_days is not None:
        params.append(since_days)
        where.append(f"c.last_message_at > now() - make_interval(days => ${len(params)})")
    where.append(
        "(SELECT direction FROM message m WHERE m.conversation_id = c.id "
        " ORDER BY m.created_at DESC LIMIT 1) = 'in'"
    )
    async with kpi.acquire() as conn:
        return await conn.fetchval(
            f"SELECT count(*) FROM conversation c WHERE {' AND '.join(where)}",
            *params,
        ) or 0


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
    wa_number_id: int | None = None
    wa_label: str | None = None
    wa_phone: str | None = None     # phone of the WhatsApp number that was analyzed
    casa_name: str | None = None
    top_topics: list = ()           # list of {topic, count, pct}
    avoided_topics: list = ()       # legacy field — kept for retrocompat
    top_referrals: list = ()        # list of {source, count, pct}
    kpis: dict | None = None        # numeric dashboard (volumen, estado, mood, tiempo, trato)


def _parse_jsonb(value, default):
    """Asyncpg returns JSONB columns as either str or already-decoded; normalize."""
    if value is None:
        return default
    if isinstance(value, str):
        try:
            return _json.loads(value)
        except (TypeError, ValueError):
            return default
    return value


async def _table_has_column(conn, table: str, column: str) -> bool:
    """Check whether a column exists — used for backward-compat with older DBs
    where migration 0010 hasn't been applied yet."""
    return bool(await conn.fetchval(
        """
        SELECT 1 FROM information_schema.columns
        WHERE table_name = $1 AND column_name = $2
        LIMIT 1
        """,
        table, column,
    ))


async def get_latest_meta_analysis(
    kpi: asyncpg.Pool, casa_id: int
) -> CasaMetaAnalysis | None:
    async with kpi.acquire() as conn:
        exists = await conn.fetchval("SELECT to_regclass('public.casa_meta_analysis')")
        if not exists:
            return None
        has_topics = await _table_has_column(conn, "casa_meta_analysis", "top_topics")
        has_kpis = await _table_has_column(conn, "casa_meta_analysis", "kpis")
        topic_cols = (
            ", top_topics, avoided_topics, top_referrals"
            if has_topics else ""
        )
        kpis_col = ", kpis" if has_kpis else ""
        row = await conn.fetchrow(
            f"""
            SELECT m.id, m.account_id, m.wa_number_id, m.run_at,
                   m.conversations_analyzed,
                   m.summary, m.patterns, m.strengths, m.improvements,
                   m.client_profile,
                   wn.label AS wa_label,
                   wn.phone AS wa_phone
                   {topic_cols}
                   {kpis_col}
            FROM casa_meta_analysis m
            LEFT JOIN wa_number wn ON wn.id = m.wa_number_id
            WHERE m.account_id = $1
            ORDER BY m.run_at DESC LIMIT 1
            """,
            casa_id,
        )
    if not row:
        return None
    return CasaMetaAnalysis(
        id=row["id"], account_id=row["account_id"], run_at=row["run_at"],
        conversations_analyzed=row["conversations_analyzed"],
        summary=row["summary"],
        patterns=_parse_jsonb(row["patterns"], []),
        strengths=_parse_jsonb(row["strengths"], []),
        improvements=_parse_jsonb(row["improvements"], []),
        client_profile=row["client_profile"],
        wa_number_id=row["wa_number_id"],
        wa_label=row["wa_label"],
        wa_phone=row["wa_phone"],
        casa_name=None,
        top_topics=_parse_jsonb(row.get("top_topics") if has_topics else None, []),
        avoided_topics=_parse_jsonb(row.get("avoided_topics") if has_topics else None, []),
        top_referrals=_parse_jsonb(row.get("top_referrals") if has_topics else None, []),
        kpis=_parse_jsonb(row.get("kpis") if has_kpis else None, None),
    )


async def list_meta_analyses(
    kpi: asyncpg.Pool, casa_id: int, days: int = 30, limit: int = 10,
    wa_number_id: int | None = None,
) -> list[CasaMetaAnalysis]:
    async with kpi.acquire() as conn:
        exists = await conn.fetchval("SELECT to_regclass('public.casa_meta_analysis')")
        if not exists:
            return []
        has_topics = await _table_has_column(conn, "casa_meta_analysis", "top_topics")
        has_kpis = await _table_has_column(conn, "casa_meta_analysis", "kpis")
        topic_cols = (
            ", m.top_topics, m.avoided_topics, m.top_referrals"
            if has_topics else ""
        )
        kpis_col = ", m.kpis" if has_kpis else ""
        wa_filter = "AND m.wa_number_id = $4" if wa_number_id is not None else ""
        params: list = [casa_id, days, limit]
        if wa_number_id is not None:
            params.append(wa_number_id)
        rows = await conn.fetch(
            f"""
            SELECT m.id, m.account_id, m.wa_number_id, m.run_at,
                   m.conversations_analyzed,
                   m.summary, m.patterns, m.strengths, m.improvements,
                   m.client_profile,
                   wn.label AS wa_label,
                   wn.phone AS wa_phone
                   {topic_cols}
                   {kpis_col}
            FROM casa_meta_analysis m
            LEFT JOIN wa_number wn ON wn.id = m.wa_number_id
            WHERE m.account_id = $1
              AND m.run_at > now() - make_interval(days => $2)
              {wa_filter}
            ORDER BY m.run_at DESC LIMIT $3
            """,
            *params,
        )
    return [
        CasaMetaAnalysis(
            id=r["id"], account_id=r["account_id"], run_at=r["run_at"],
            conversations_analyzed=r["conversations_analyzed"],
            summary=r["summary"],
            patterns=_parse_jsonb(r["patterns"], []),
            strengths=_parse_jsonb(r["strengths"], []),
            improvements=_parse_jsonb(r["improvements"], []),
            client_profile=r["client_profile"],
            wa_number_id=r["wa_number_id"],
            wa_label=r["wa_label"],
            wa_phone=r["wa_phone"],
            casa_name=None,
            top_topics=_parse_jsonb(r.get("top_topics") if has_topics else None, []),
            avoided_topics=_parse_jsonb(r.get("avoided_topics") if has_topics else None, []),
            top_referrals=_parse_jsonb(r.get("top_referrals") if has_topics else None, []),
            kpis=_parse_jsonb(r.get("kpis") if has_kpis else None, None),
        )
        for r in rows
    ]


async def list_all_meta_analyses(
    kpi: asyncpg.Pool,
    *,
    casa_id: int | None = None,
    days: int = 365,
    limit: int = 200,
) -> list[CasaMetaAnalysis]:
    """Cross-casa meta-analysis index used by the Informes page.

    Joins casa.name + wa_number.label so each row is renderable on its own.
    Optional casa filter; default 1-year window keeps the index light without
    truncating useful history."""
    async with kpi.acquire() as conn:
        exists = await conn.fetchval("SELECT to_regclass('public.casa_meta_analysis')")
        if not exists:
            return []
        has_topics = await _table_has_column(conn, "casa_meta_analysis", "top_topics")
        has_kpis = await _table_has_column(conn, "casa_meta_analysis", "kpis")
        topic_cols = (
            ", m.top_topics, m.avoided_topics, m.top_referrals"
            if has_topics else ""
        )
        kpis_col = ", m.kpis" if has_kpis else ""
        params: list = [days, limit]
        casa_filter = ""
        if casa_id is not None:
            casa_filter = "AND m.account_id = $3"
            params.append(casa_id)
        rows = await conn.fetch(
            f"""
            SELECT m.id, m.account_id, m.wa_number_id, m.run_at,
                   m.conversations_analyzed,
                   m.summary, m.patterns, m.strengths, m.improvements,
                   m.client_profile,
                   wn.label AS wa_label,
                   wn.phone AS wa_phone,
                   c.name   AS casa_name
                   {topic_cols}
                   {kpis_col}
            FROM casa_meta_analysis m
            LEFT JOIN wa_number wn ON wn.id = m.wa_number_id
            LEFT JOIN casa      c  ON c.id  = m.account_id
            WHERE m.run_at > now() - make_interval(days => $1)
              {casa_filter}
            ORDER BY m.run_at DESC LIMIT $2
            """,
            *params,
        )
    return [
        CasaMetaAnalysis(
            id=r["id"], account_id=r["account_id"], run_at=r["run_at"],
            conversations_analyzed=r["conversations_analyzed"],
            summary=r["summary"],
            patterns=_parse_jsonb(r["patterns"], []),
            strengths=_parse_jsonb(r["strengths"], []),
            improvements=_parse_jsonb(r["improvements"], []),
            client_profile=r["client_profile"],
            wa_number_id=r["wa_number_id"],
            wa_label=r["wa_label"],
            wa_phone=r["wa_phone"],
            casa_name=r["casa_name"],
            top_topics=_parse_jsonb(r.get("top_topics") if has_topics else None, []),
            avoided_topics=_parse_jsonb(r.get("avoided_topics") if has_topics else None, []),
            top_referrals=_parse_jsonb(r.get("top_referrals") if has_topics else None, []),
            kpis=_parse_jsonb(r.get("kpis") if has_kpis else None, None),
        )
        for r in rows
    ]


async def get_meta_analysis_by_id(
    kpi: asyncpg.Pool, informe_id: int,
) -> CasaMetaAnalysis | None:
    async with kpi.acquire() as conn:
        exists = await conn.fetchval("SELECT to_regclass('public.casa_meta_analysis')")
        if not exists:
            return None
        has_topics = await _table_has_column(conn, "casa_meta_analysis", "top_topics")
        has_kpis = await _table_has_column(conn, "casa_meta_analysis", "kpis")
        topic_cols = (
            ", m.top_topics, m.avoided_topics, m.top_referrals"
            if has_topics else ""
        )
        kpis_col = ", m.kpis" if has_kpis else ""
        row = await conn.fetchrow(
            f"""
            SELECT m.id, m.account_id, m.wa_number_id, m.run_at,
                   m.conversations_analyzed,
                   m.summary, m.patterns, m.strengths, m.improvements,
                   m.client_profile,
                   wn.label AS wa_label,
                   wn.phone AS wa_phone,
                   c.name   AS casa_name
                   {topic_cols}
                   {kpis_col}
            FROM casa_meta_analysis m
            LEFT JOIN wa_number wn ON wn.id = m.wa_number_id
            LEFT JOIN casa      c  ON c.id  = m.account_id
            WHERE m.id = $1
            """,
            informe_id,
        )
    if not row:
        return None
    return CasaMetaAnalysis(
        id=row["id"], account_id=row["account_id"], run_at=row["run_at"],
        conversations_analyzed=row["conversations_analyzed"],
        summary=row["summary"],
        patterns=_parse_jsonb(row["patterns"], []),
        strengths=_parse_jsonb(row["strengths"], []),
        improvements=_parse_jsonb(row["improvements"], []),
        client_profile=row["client_profile"],
        wa_number_id=row["wa_number_id"],
        wa_label=row["wa_label"],
        wa_phone=row["wa_phone"],
        casa_name=row["casa_name"],
        top_topics=_parse_jsonb(row.get("top_topics") if has_topics else None, []),
        avoided_topics=_parse_jsonb(row.get("avoided_topics") if has_topics else None, []),
        top_referrals=_parse_jsonb(row.get("top_referrals") if has_topics else None, []),
        kpis=_parse_jsonb(row.get("kpis") if has_kpis else None, None),
    )


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


# ═══════════════════════════════════════════════════════════════════
# Agent knowledge base (migration 0013) — casa_profile + girl
#
# Read-side for the WhatsApp reply agent (app/agent/reply_engine.py). All SQL
# lives here per the project rule "todo el SQL en queries.py". JSONB columns are
# normalized through `_parse_jsonb` exactly like the meta-analysis helpers above.
# ═══════════════════════════════════════════════════════════════════

# Per-turn history body cap (chars). Mirrors the WordPress plugin
# (claude.php line 227) so the prompt token cost stays bounded on long chats.
_TURN_BODY_MAXLEN = 1000


@dataclass(frozen=True)
class GirlRow:
    id: int
    casa_id: int
    ext_id: str | None
    name: str
    age: int | None
    nationality: str | None
    description: str | None
    photo_url: str | None
    whatsapp: str | None
    available_today: bool
    outcall: bool
    escort_pareja: bool
    services: list[str]
    languages: list[str]


@dataclass(frozen=True)
class CasaProfileRow:
    casa_id: int
    casa_name: str
    bot_name: str | None
    default_lang: str
    whatsapp_recepcion: str | None
    telegram_recepcion: str | None
    greetings: dict
    rates: dict
    schedule: dict
    faqs: list
    outcall: dict
    address: str | None
    address_lat: float | None
    address_lng: float | None
    maps_url: str | None


@dataclass(frozen=True)
class CasaKnowledge:
    """Everything the reply agent needs to answer for one casa: the persona/
    rates/schedule profile plus the girls bookable right now."""

    profile: CasaProfileRow | None
    girls_available: list[GirlRow]


def _girl_from_row(r: asyncpg.Record) -> GirlRow:
    return GirlRow(
        id=r["id"],
        casa_id=r["casa_id"],
        ext_id=r["ext_id"],
        name=r["name"],
        age=r["age"],
        nationality=r["nationality"],
        description=r["description"],
        photo_url=r["photo_url"],
        whatsapp=r["whatsapp"],
        available_today=r["available_today"],
        outcall=r["outcall"],
        escort_pareja=r["escort_pareja"],
        services=_parse_jsonb(r["services"], []),
        languages=_parse_jsonb(r["languages"], []),
    )


def _profile_from_row(r: asyncpg.Record) -> CasaProfileRow:
    return CasaProfileRow(
        casa_id=r["casa_id"],
        casa_name=r["casa_name"],
        bot_name=r["bot_name"],
        default_lang=r["default_lang"],
        whatsapp_recepcion=r["whatsapp_recepcion"],
        telegram_recepcion=r["telegram_recepcion"],
        greetings=_parse_jsonb(r["greetings"], {}),
        rates=_parse_jsonb(r["rates"], {}),
        schedule=_parse_jsonb(r["schedule"], {}),
        faqs=_parse_jsonb(r["faqs"], []),
        outcall=_parse_jsonb(r["outcall"], {}),
        address=r["address"],
        address_lat=r["address_lat"],
        address_lng=r["address_lng"],
        maps_url=r["maps_url"],
    )


async def get_casa_knowledge(
    kpi: asyncpg.Pool, casa_id: int
) -> CasaKnowledge:
    """Load the casa_profile (1:1, joined with casa.name) and the girls bookable
    today (active + available_today). The girls are narrowed via
    ix_girl_casa_available; the sort_order/name ordering is an in-memory sort."""
    async with kpi.acquire() as conn:
        prof_row = await conn.fetchrow(
            """
            SELECT cp.casa_id, c.name AS casa_name, cp.bot_name, cp.default_lang,
                   cp.whatsapp_recepcion, cp.telegram_recepcion,
                   cp.greetings, cp.rates, cp.schedule, cp.faqs, cp.outcall,
                   cp.address, cp.address_lat, cp.address_lng, cp.maps_url
            FROM casa_profile cp
            JOIN casa c ON c.id = cp.casa_id
            WHERE cp.casa_id = $1
            """,
            casa_id,
        )
        girl_rows = await conn.fetch(
            """
            SELECT id, casa_id, ext_id, name, age, nationality, description,
                   photo_url, whatsapp, available_today, outcall, escort_pareja,
                   services, languages
            FROM girl
            WHERE casa_id = $1 AND available_today = TRUE AND active = TRUE
            ORDER BY sort_order ASC, name ASC
            """,
            casa_id,
        )
    return CasaKnowledge(
        profile=_profile_from_row(prof_row) if prof_row else None,
        girls_available=[_girl_from_row(r) for r in girl_rows],
    )


async def get_available_girls_with_photo(
    kpi: asyncpg.Pool, casa_id: int
) -> list[GirlRow]:
    """Girls bookable today for one casa that ALSO have a non-null photo_url.

    Narrower sibling of `get_casa_knowledge`'s girl SELECT: same filter
    (available_today + active) plus `photo_url IS NOT NULL`, same ordering
    (sort_order ASC, name ASC). Used by the photo-card step when the reply
    engine's already-loaded knowledge is not in scope. Parametrized SQL only.
    """
    async with kpi.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, casa_id, ext_id, name, age, nationality, description,
                   photo_url, whatsapp, available_today, outcall, escort_pareja,
                   services, languages
            FROM girl
            WHERE casa_id = $1 AND available_today = TRUE AND active = TRUE
              AND photo_url IS NOT NULL
            ORDER BY sort_order ASC, name ASC
            """,
            casa_id,
        )
    return [_girl_from_row(r) for r in rows]


# ═══════════════════════════════════════════════════════════════════
# Write-side for the website→DB knowledge sync (app/agent/website_sync.py).
# Mirrors each casa's LIVE plugin JSON (config + girls) into casa_profile and
# girl so the reply agent always sees the current girls + rates. All SQL stays
# here per the project rule "todo el SQL en queries.py"; JSONB columns are cast
# inline with ::jsonb and fed json.dumps(...) strings, matching the analysis
# upsert in worker.py. Parametrized positional placeholders only — no f-strings.
# ═══════════════════════════════════════════════════════════════════


async def resolve_casa_id_by_keyword(
    kpi: asyncpg.Pool, keyword: str
) -> int | None:
    """Resolve a casa keyword (e.g. "vlc") to a casa_id via case-insensitive
    name match. The `%` wildcards are placed in the bound Python value (never
    concatenated into the SQL) so the query stays parametrized. The casa table
    is admin-scale, so the seq scan a `%…%` ILIKE forces is acceptable; LIMIT 1
    bounds it and ORDER BY name makes the pick deterministic when several casas
    match."""
    async with kpi.acquire() as conn:
        return await conn.fetchval(
            "SELECT id FROM casa WHERE name ILIKE $1 ORDER BY name ASC LIMIT 1",
            f"%{keyword}%",
        )


async def upsert_casa_profile_from_sync(
    kpi: asyncpg.Pool,
    *,
    casa_id: int,
    bot_name: str | None,
    whatsapp_recepcion: str | None,
    telegram_recepcion: str | None,
    greetings: dict,
    rates: dict,
    schedule: dict,
    faqs: list,
    address: str | None,
    maps_url: str | None,
) -> None:
    """UPSERT casa_profile keyed on its primary key (casa_id). Only the fields
    sourced from the plugin config are written; `outcall` (base price + taxi
    tariff + surcharge %) is deliberately NOT in the column list nor the UPDATE
    set, so the manually-curated outcall pricing JSONB is preserved on conflict.
    `faqs` is likewise PRESERVED when the incoming feed has none (empty list):
    the public /config endpoint strips faqs, so an unconditional overwrite would
    wipe FAQs curated directly in casa_profile (see docs/FAQS.md) on every sync.
    `created_at`/`default_lang` keep their server defaults on insert; there is
    no DB trigger for `updated_at`, so it is set with now() like the analysis
    upsert sets analyzed_at."""
    async with kpi.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO casa_profile (
                casa_id, bot_name, whatsapp_recepcion, telegram_recepcion,
                greetings, rates, schedule, faqs, address, maps_url
            ) VALUES (
                $1, $2, $3, $4,
                $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10
            )
            ON CONFLICT (casa_id) DO UPDATE SET
                bot_name = EXCLUDED.bot_name,
                whatsapp_recepcion = EXCLUDED.whatsapp_recepcion,
                telegram_recepcion = EXCLUDED.telegram_recepcion,
                greetings = EXCLUDED.greetings,
                rates = EXCLUDED.rates,
                schedule = EXCLUDED.schedule,
                -- Preserve hand/seeded faqs when the feed brings none (public
                -- /config strips faqs → EXCLUDED.faqs is '[]' on every sync).
                faqs = CASE
                    WHEN EXCLUDED.faqs IS NULL OR EXCLUDED.faqs = '[]'::jsonb
                    THEN casa_profile.faqs
                    ELSE EXCLUDED.faqs
                END,
                address = EXCLUDED.address,
                maps_url = EXCLUDED.maps_url,
                updated_at = now()
            """,
            casa_id,
            bot_name,
            whatsapp_recepcion,
            telegram_recepcion,
            _json.dumps(greetings),
            _json.dumps(rates),
            _json.dumps(schedule),
            _json.dumps(faqs),
            address,
            maps_url,
        )


async def upsert_girl_from_sync(
    kpi: asyncpg.Pool,
    *,
    casa_id: int,
    ext_id: str,
    name: str,
    age: int | None,
    nationality: str | None,
    description: str | None,
    photo_url: str | None,
    services: list,
    languages: list,
    whatsapp: str | None,
    available_today: bool,
    outcall: bool,
    escort_pareja: bool,
) -> None:
    """UPSERT one plugin-sourced girl by (casa_id, ext_id). The conflict target
    is the PARTIAL unique index `uq_girl_casa_ext` (predicate ext_id IS NOT
    NULL), so the index predicate must be restated in the ON CONFLICT clause —
    a bare `ON CONFLICT (casa_id, ext_id)` would not match it. Callers must only
    route rows with a non-null ext_id here; manually-added girls (ext_id NULL)
    are not represented in the index and would always INSERT. `active` is forced
    TRUE: a girl present in the plugin feed is, by definition, listed."""
    async with kpi.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO girl (
                casa_id, ext_id, name, age, nationality, description,
                photo_url, whatsapp, available_today, outcall, escort_pareja,
                services, languages, active
            ) VALUES (
                $1, $2, $3, $4, $5, $6,
                $7, $8, $9, $10, $11,
                $12::jsonb, $13::jsonb, TRUE
            )
            ON CONFLICT (casa_id, ext_id) WHERE ext_id IS NOT NULL DO UPDATE SET
                name = EXCLUDED.name,
                age = EXCLUDED.age,
                nationality = EXCLUDED.nationality,
                description = EXCLUDED.description,
                photo_url = EXCLUDED.photo_url,
                whatsapp = EXCLUDED.whatsapp,
                available_today = EXCLUDED.available_today,
                outcall = EXCLUDED.outcall,
                escort_pareja = EXCLUDED.escort_pareja,
                services = EXCLUDED.services,
                languages = EXCLUDED.languages,
                active = TRUE,
                updated_at = now()
            """,
            casa_id,
            ext_id,
            name,
            age,
            nationality,
            description,
            photo_url,
            whatsapp,
            available_today,
            outcall,
            escort_pareja,
            _json.dumps(services),
            _json.dumps(languages),
        )


async def deactivate_girls_not_in(
    kpi: asyncpg.Pool, casa_id: int, ext_ids: list[str]
) -> int:
    """Soft-delete the absent half of an "upsert present, deactivate absent"
    sync: mark a casa's plugin-sourced girls whose ext_id is NOT in the freshly
    fetched id set as active = FALSE, so the bot stops mentioning girls no longer
    listed. Guards `ext_id IS NOT NULL` so manually-added girls are never touched
    by a plugin sync. asyncpg binds the Python list[str] directly to a text[]
    param. Returns the number of rows deactivated.

    Safety: an empty `ext_ids` would make `<> ALL('{}')` TRUE for every row and
    wipe the casa's whole roster, so an empty list is treated as a NO-OP — a sync
    that produced zero usable girls must never deactivate everything."""
    if not ext_ids:
        return 0
    async with kpi.acquire() as conn:
        status = await conn.execute(
            """
            UPDATE girl
               SET active = FALSE, updated_at = now()
             WHERE casa_id = $1
               AND active = TRUE
               AND ext_id IS NOT NULL
               AND ext_id <> ALL($2::text[])
            """,
            casa_id,
            ext_ids,
        )
        # asyncpg returns the command tag, e.g. "UPDATE 3" — parse the count.
        try:
            return int(status.split()[-1])
        except (ValueError, IndexError):
            return 0


@dataclass(frozen=True)
class ChatTurn:
    role: str       # "user" (incoming) | "assistant" (our reply)
    content: str


async def get_recent_turns(
    kpi: asyncpg.Pool, conv_id: int, limit: int = 8
) -> list[ChatTurn]:
    """Last `limit` text turns of a conversation, oldest→newest, ready for the
    Anthropic messages array. Media-only rows (no body) are skipped; each body
    is capped at _TURN_BODY_MAXLEN chars. Covered by ix_message_conv_created_desc.
    """
    async with kpi.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT direction, body
            FROM message
            WHERE conversation_id = $1 AND body IS NOT NULL AND body <> ''
            ORDER BY created_at DESC
            LIMIT $2
            """,
            conv_id, limit,
        )
    turns: list[ChatTurn] = []
    for r in reversed(rows):  # DB gave newest-first; flip to chronological
        role = "user" if r["direction"] == "in" else "assistant"
        turns.append(ChatTurn(role=role, content=r["body"][:_TURN_BODY_MAXLEN]))
    return turns


@dataclass(frozen=True)
class AnalysisHint:
    """The analyzer's latest signal for a single conversation, distilled for the
    reply engine's soft hint. `action` is the NextActionResult enum code (see
    app.models.ActionType); `why` is its free-text Spanish justification.

    Built from a single analysis row (analysis.conversation_id is UNIQUE, so no
    "latest" dedup is needed). Either field may be None when that part of the
    analysis is absent — the caller treats it as a best-effort hint only.
    """
    action: str | None
    why: str | None


async def get_latest_analysis_hint(
    kpi: asyncpg.Pool, conv_id: int
) -> AnalysisHint | None:
    """Fetch the analyzer's signal for a conversation, distilled for Sara's soft
    hint. Returns None when the conversation has no analysis row yet (fail-soft:
    conversations without analysis behave exactly as before).

    analysis.conversation_id is UNIQUE (one row per conversation), so this is a
    plain equality lookup — no DISTINCT ON / ORDER BY analyzed_at dedup needed.
    The next_action JSONB sub-fields are extracted in SQL via ->> so we
    return small scalars instead of whole JSON blobs. All parametrized ($1).
    """
    async with kpi.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT
                a.next_action->>'action' AS action,
                a.next_action->>'why'    AS why
            FROM analysis a
            WHERE a.conversation_id = $1
            """,
            conv_id,
        )
    if row is None:
        return None
    return AnalysisHint(action=row["action"], why=row["why"])


# ═══════════════════════════════════════════════════════════════════
# Per-client memory (F3) — remember one contact's preferred language +
# the girls they showed interest in, scoped to ONE conversation only.
# ═══════════════════════════════════════════════════════════════════
# Storage is 1:1 with conversation (conversation_memory.conversation_id is the PK
# and a CASCADE FK), so the per-conversation scope ("1 conv = 1 cliente", same
# wa_number only — never cross numbers) is enforced by the schema, not by code.
# All SQL parametrized; no f-string SQL. Read-time 90-day freshness gives expiry
# without a cron. We store girl NAMES, not ids (see migration 0015 docstring).

# Cap the remembered-girls list to bound row growth. The caller (reply_engine)
# does the merge/dedup and trims to this many before writing; the query is a dumb
# writer that stores whatever final list it is handed.
_MEMORY_MAX_GIRLS = 5

# Read-side freshness window: memory older than this is treated as absent
# (read-time expiry — no cron needed). Kept here so get/upsert agree on the clock.
_MEMORY_FRESHNESS_DAYS = 90


@dataclass(frozen=True)
class ClientMemory:
    """What we silently remember about ONE contact on ONE wa_number: the language
    they tend to write in and the girl NAMES they showed interest in.

    Either field may be None/empty — the caller treats it as a best-effort,
    silent hint (Sara adapts language + may re-offer the girl, never says she
    remembers). Stale rows (no contact for ~90 days) are never returned.
    """
    preferred_lang: str | None
    preferred_girls: list[str]


async def get_client_memory(
    kpi: asyncpg.Pool, conversation_id: int
) -> ClientMemory | None:
    """Fetch the per-conversation memory, applying a 90-day freshness filter in
    SQL. Returns None when there is no row OR the row is stale (read-time expiry,
    so no cron is needed). Fail-soft for the reply engine: a None is the same as
    "no memory", which leaves the prompt byte-for-byte unchanged.

    conversation_memory.conversation_id is the PK (1:1), so this is a plain
    equality lookup. The interval is bound as a parameter — no f-string SQL.
    """
    async with kpi.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT preferred_lang, preferred_girls
            FROM conversation_memory
            WHERE conversation_id = $1
              AND updated_at > now() - make_interval(days => $2)
            """,
            conversation_id,
            _MEMORY_FRESHNESS_DAYS,
        )
    if row is None:
        return None
    return ClientMemory(
        preferred_lang=row["preferred_lang"],
        preferred_girls=list(row["preferred_girls"] or []),
    )


async def upsert_client_memory(
    kpi: asyncpg.Pool,
    conversation_id: int,
    preferred_lang: str | None,
    preferred_girls: list[str],
) -> None:
    """UPSERT the per-conversation memory keyed on its PK (conversation_id), with
    `updated_at = now()` so the row stays fresh on every contact.

    The query is a dumb writer: the caller has already merged/deduped the girls
    list and ordered it most-recent-first. We still hard-cap it to
    `_MEMORY_MAX_GIRLS` here as a defensive bound on row growth. There is no DB
    trigger for updated_at, so it is set explicitly like the other upserts. All
    parametrized ($1..$3).
    """
    girls = list(preferred_girls or [])[:_MEMORY_MAX_GIRLS]
    async with kpi.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO conversation_memory (
                conversation_id, preferred_lang, preferred_girls, updated_at
            ) VALUES ($1, $2, $3, now())
            ON CONFLICT (conversation_id) DO UPDATE SET
                preferred_lang = EXCLUDED.preferred_lang,
                preferred_girls = EXCLUDED.preferred_girls,
                updated_at = now()
            """,
            conversation_id,
            preferred_lang,
            girls,
        )


# ═══════════════════════════════════════════════════════════════════
# Agent runtime (F2) — per-number mode, per-conversation pause state
# ═══════════════════════════════════════════════════════════════════
# All parametrized; no f-string SQL. The auto_reply_job re-reads mode +
# agent_status itself (it never trusts the webhook), so these are the single
# source of truth for the enqueue gate AND the worker re-check.

# Recent-human-outbound window: a receptionist send within this many minutes
# pauses the agent (paused_human). Default mirrors the job constant.
_HUMAN_OUTBOUND_WINDOW_MIN = 30


async def get_wa_mode_for_conversation(kpi: asyncpg.Pool, conv_id: int) -> str:
    """Resolve the wa_number.mode (off|auto|copilot) for a conversation.

    Returns 'off' when the conversation is missing, has no wa_number, or the
    mode column is somehow NULL — so an unknown/unwired conversation never
    triggers a reply. The default 'off' keeps the whole agent inert.
    """
    async with kpi.acquire() as conn:
        mode = await conn.fetchval(
            """
            SELECT wn.mode
            FROM conversation c
            JOIN wa_number wn ON wn.id = c.wa_number_id
            WHERE c.id = $1
            """,
            conv_id,
        )
    return mode or "off"


async def get_conversation_agent_status(
    kpi: asyncpg.Pool, conv_id: int
) -> str | None:
    """Current agent pause state of a conversation.

    NULL == active (never paused). Set values: 'active' (explicitly un-paused),
    'paused_human' (receptionist took over), 'paused_risk' (guardrail tripped).
    """
    async with kpi.acquire() as conn:
        return await conn.fetchval(
            "SELECT agent_status FROM conversation WHERE id = $1",
            conv_id,
        )


async def set_conversation_agent_status(
    kpi: asyncpg.Pool, conv_id: int, agent_status: str | None
) -> None:
    """Set the agent pause state and stamp agent_paused_at.

    agent_paused_at is set to now() for a pause state and cleared (NULL) when
    the status is reset to 'active'/NULL. updated_at is bumped for UI ordering.
    """
    paused = agent_status in ("paused_human", "paused_risk")
    async with kpi.acquire() as conn:
        await conn.execute(
            """
            UPDATE conversation
            SET agent_status = $2,
                agent_paused_at = CASE WHEN $3 THEN now() ELSE NULL END,
                updated_at = now()
            WHERE id = $1
            """,
            conv_id, agent_status, paused,
        )


async def has_recent_human_outbound(
    kpi: asyncpg.Pool, conv_id: int, within_minutes: int = _HUMAN_OUTBOUND_WINDOW_MIN
) -> bool:
    """True if a HUMAN (non-agent) outbound message was sent in this conversation
    within `within_minutes`. Backed by ix_message_conv_agent_created.

    Excludes the agent's OWN echo: when the bot sends, WAHA re-delivers that
    message via the message.any webhook (fromMe=true) and it may land as a second
    row with agent_generated=FALSE (id mismatch). Such a row has the SAME body as
    a recent agent_generated=TRUE row, so we discount it — otherwise the bot would
    mistake its own message for a human takeover and pause itself."""
    async with kpi.acquire() as conn:
        return bool(await conn.fetchval(
            """
            SELECT EXISTS (
                SELECT 1 FROM message m
                WHERE m.conversation_id = $1
                  AND m.direction = 'out'
                  AND m.agent_generated = FALSE
                  AND m.created_at > now() - make_interval(mins => $2)
                  AND NOT EXISTS (
                      SELECT 1 FROM message a
                      WHERE a.conversation_id = $1
                        AND a.direction = 'out'
                        AND a.agent_generated = TRUE
                        AND a.body = m.body
                        AND a.created_at > now() - make_interval(mins => $2)
                  )
            )
            """,
            conv_id, within_minutes,
        ))


async def set_wa_mode(kpi: asyncpg.Pool, wa_number_id: int, mode: str) -> None:
    """Set a wa_number's agent mode. The caller MUST validate `mode` against the
    allowed set before calling (the DB CHECK is the last line of defense)."""
    async with kpi.acquire() as conn:
        await conn.execute(
            "UPDATE wa_number SET mode = $2 WHERE id = $1",
            wa_number_id, mode,
        )


async def insert_alert(
    kpi: asyncpg.Pool,
    *,
    type: str,
    severity: str,
    message: str,
    conversation_id: int | None = None,
    inbox_id: int | None = None,
) -> None:
    """Generic alert writer. acknowledged_at is left NULL (== active/unack),
    matching the existing 'unack == active' convention used across the app."""
    async with kpi.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO alert (type, severity, conversation_id, inbox_id, message, created_at)
            VALUES ($1, $2, $3, $4, $5, now())
            """,
            type, severity, conversation_id, inbox_id, message,
        )


async def get_alert(kpi: asyncpg.Pool, alert_id: int) -> AlertRow | None:
    """Fetch a single alert by id (used by the copilot-send route to read the
    stored suggestion text and confirm it belongs to the conversation).

    Reuses the shared AlertRow dataclass (defined above near get_casa_alerts)."""
    async with kpi.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id, type, severity, conversation_id, inbox_id, message,
                   created_at, acknowledged_at
            FROM alert WHERE id = $1
            """,
            alert_id,
        )
    return AlertRow(**dict(row)) if row else None


async def get_pending_suggestion(
    kpi: asyncpg.Pool, conversation_id: int
) -> AlertRow | None:
    """Most recent UNACKED copilot suggestion for a conversation, if any.

    Powers the in-conversation 1-click "Enviar" control. Returns None when no
    copilot draft is pending (mode != copilot, or already sent/acked)."""
    async with kpi.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id, type, severity, conversation_id, inbox_id, message,
                   created_at, acknowledged_at
            FROM alert
            WHERE conversation_id = $1
              AND type = 'agent_suggestion'
              AND acknowledged_at IS NULL
            ORDER BY created_at DESC
            LIMIT 1
            """,
            conversation_id,
        )
    return AlertRow(**dict(row)) if row else None


async def ack_alert(kpi: asyncpg.Pool, alert_id: int) -> bool:
    """Acknowledge a single alert (idempotent — only flips an unacked row).

    Returns True iff a row was updated. Shared by the Alertas page ack button
    and the copilot-send route (which acks the agent_suggestion it just sent).
    Mirrors the inline UPDATE that previously lived only in routes/alerts.py."""
    async with kpi.acquire() as conn:
        result = await conn.execute(
            "UPDATE alert SET acknowledged_at = now() WHERE id = $1 AND acknowledged_at IS NULL",
            alert_id,
        )
    return result.endswith(" 1")


async def supersede_pending_suggestions(
    kpi: asyncpg.Pool, conversation_id: int
) -> int:
    """Ack any UNACKED copilot suggestions for a conversation (dedup helper).

    Called by the copilot branch of auto_reply_job BEFORE inserting a fresh
    agent_suggestion so at most ONE suggestion is ever pending per conversation:
    each new incoming client message supersedes the prior unsent draft instead of
    piling up N unacked rows. Returns the number of rows superseded.
    Parametrized — no user data interpolated."""
    async with kpi.acquire() as conn:
        result = await conn.execute(
            """
            UPDATE alert
            SET acknowledged_at = now()
            WHERE conversation_id = $1
              AND type = 'agent_suggestion'
              AND acknowledged_at IS NULL
            """,
            conversation_id,
        )
    # Command tag is e.g. 'UPDATE 3'; parse the affected-row count. Defensive
    # against a driver/stub returning None or a non-UPDATE tag → 0.
    if isinstance(result, str) and result.startswith("UPDATE"):
        return int(result.rsplit(" ", 1)[-1])
    return 0


async def ack_all_suggestions(kpi: asyncpg.Pool, conversation_id: int) -> int:
    """Ack ALL unacked agent_suggestion rows for a conversation (idempotent).

    Used by the copilot-send route so the Sara badge clears fully even if, due to
    a race or legacy rows, more than one suggestion was pending. Same UPDATE as
    supersede_pending_suggestions; named separately to document intent at the two
    call sites (dedup-before-insert vs clear-on-send). Returns rows acked."""
    return await supersede_pending_suggestions(kpi, conversation_id)


@dataclass(frozen=True)
class InboxAttentionCounts:
    """Three SEPARATE inbox-awareness counters for the header indicator.

    - paused_risk: unacked alerts where the bot halted on a safety guardrail
      (the bot stopped attending — most prominent).
    - pending_suggestions: unacked copilot drafts waiting to be sent (silent).
    - hot_leads: open conversations whose latest conv_probability >= threshold
      and whose last message is from the client (still waiting on us).
    """
    paused_risk: int
    pending_suggestions: int
    hot_leads: int


async def count_inbox_attention(
    kpi_pool: asyncpg.Pool,
) -> InboxAttentionCounts:
    """Counts powering the in-panel notification badge (item 5).

    Returns the three signals SEPARATELY so the front end can apply the strict
    sound policy (sound only on paused_risk / hot_lead increases). Mirrors the
    'unack == active' convention (acknowledged_at IS NULL). All parametrized —
    no user data interpolated.

    The alert counters carry the SAME 48h recency bound as the critical-alerts
    policy (see _critical_alerts_where) so the badge ages out and never trends to
    permanent red. hot_leads is derived from current analysis (not alerts), so it
    already reflects live conversations and needs no extra time bound here.
    """
    async with kpi_pool.acquire() as conn:
        alert_row = await conn.fetchrow(
            """
            SELECT
              count(*) FILTER (WHERE type = 'paused_risk')      AS paused_risk,
              count(*) FILTER (WHERE type = 'agent_suggestion')  AS pending
            FROM alert
            WHERE acknowledged_at IS NULL
              AND created_at > now() - interval '48 hours'
              AND type IN ('paused_risk', 'agent_suggestion')
            """
        )
        hot = await conn.fetchval(
            """
            SELECT count(*)
            FROM conversation c
            JOIN analysis a ON a.conversation_id = c.id
            WHERE c.status <> 'resolved'
              AND a.conv_probability >= $1
              AND (SELECT direction FROM message m WHERE m.conversation_id = c.id
                   ORDER BY m.created_at DESC LIMIT 1) = 'in'
            """,
            HOT_LEAD_THRESHOLD,
        ) or 0
    return InboxAttentionCounts(
        paused_risk=int(alert_row["paused_risk"] or 0),
        pending_suggestions=int(alert_row["pending"] or 0),
        hot_leads=int(hot),
    )


# ═══════════════════════════════════════════════════════════════════
# Follow-up of abandoned quotes (migration 0016) — find conversations where
# Sara quoted a price/offer on an AUTO number and the client then went silent,
# so ONE warm re-engagement nudge may be sent (max 1 EVER, race-safe via the
# atomic claim below). All SQL parametrized; no f-string SQL.
# ═══════════════════════════════════════════════════════════════════


@dataclass(frozen=True)
class FollowupCandidate:
    """A conversation eligible for a single abandoned-quote follow-up nudge.

    Carries everything the send job needs WITHOUT a second round-trip:
    `waha_session` (the per-number session to send through / key the anti-ban),
    `chat_id` (the contact JID to send to) and `last_agent_body` (the last agent
    message, re-checked for a concrete price by the send job). The send job still
    re-loads mode/agent_status and re-validates the last message (TOCTOU) — these
    fields are the sweep snapshot, not trusted state.
    """
    conversation_id: int
    casa_id: int
    waha_session: str | None
    chat_id: str | None
    last_agent_body: str | None


async def list_followup_candidates(
    kpi: asyncpg.Pool,
    *,
    min_silence_min: int = 30,
    max_silence_min: int = 180,
    limit: int = 20,
) -> list[FollowupCandidate]:
    """Conversations whose LAST message is Sara's agent send, sent between
    `min_silence_min` and `max_silence_min` ago, on an AUTO number, not paused,
    and never yet followed up — i.e. the client went silent after Sara's turn.

    Conditions (all enforced in SQL, all parametrized):
      * wn.mode = 'auto'                       — follow-up is auto-only
      * agent_status IS NULL OR = 'active'     — NEVER paused_human/paused_risk
      * agent_followup_at IS NULL              — max 1 follow-up EVER (narrows set;
                                                 the atomic claim makes it race-safe)
      * the conversation's LAST message is direction='out' AND
        agent_generated=TRUE                   — Sara spoke last (the offer turn)
      * that last message's created_at is in [now-max, now-min]  — silent window
      * NO inbound message after it             — satisfied BY CONSTRUCTION: an
        inbound newer than the agent message WOULD be the last message, so the
        DISTINCT ON last_msg row would not be the agent send.

    The "concrete price/offer" rule is NOT pre-filtered here (the schema has no
    price flag); the send job confirms it via has_price(last_agent_body) before
    sending. Bounded by `last_message_at > now-max` (covered by
    ix_conversation_casa_last) and a hard LIMIT so a cron tick stays cheap.
    """
    lim = max(1, min(int(limit), 100))
    async with kpi.acquire() as conn:
        rows = await conn.fetch(
            """
            WITH last_msg AS (
                SELECT DISTINCT ON (m.conversation_id)
                    m.conversation_id, m.direction, m.agent_generated,
                    m.created_at, m.body
                FROM message m
                WHERE m.conversation_id IN (
                    SELECT id FROM conversation
                    WHERE last_message_at > now() - make_interval(mins => $1)
                )
                ORDER BY m.conversation_id, m.created_at DESC
            )
            SELECT
                c.id AS conversation_id,
                c.casa_id,
                coalesce(wn.session, casa.waha_session) AS waha_session,
                ct.waha_jid AS chat_id,
                lm.body AS last_agent_body
            FROM conversation c
            JOIN wa_number wn ON wn.id = c.wa_number_id
            JOIN casa ON casa.id = c.casa_id
            JOIN contact ct ON ct.id = c.contact_id
            JOIN last_msg lm ON lm.conversation_id = c.id
            WHERE wn.mode = 'auto'
              AND (c.agent_status IS NULL OR c.agent_status = 'active')
              AND c.agent_followup_at IS NULL
              AND lm.direction = 'out'
              AND lm.agent_generated = TRUE
              AND lm.created_at < now() - make_interval(mins => $2)
              AND lm.created_at > now() - make_interval(mins => $1)
            ORDER BY lm.created_at ASC
            LIMIT $3
            """,
            max_silence_min, min_silence_min, lim,
        )
    return [
        FollowupCandidate(
            conversation_id=r["conversation_id"],
            casa_id=r["casa_id"],
            waha_session=r["waha_session"],
            chat_id=r["chat_id"],
            last_agent_body=r["last_agent_body"],
        )
        for r in rows
    ]


async def get_followup_at(
    kpi: asyncpg.Pool, conversation_id: int
) -> datetime | None:
    """The conversation's agent_followup_at, or None if not yet followed up.

    Cheap read used by the send job for an early skip (avoid burning an LLM call
    when the marker is already set). NOT the race guard — claim_followup is the
    atomic guard. Parametrized ($1)."""
    async with kpi.acquire() as conn:
        return await conn.fetchval(
            "SELECT agent_followup_at FROM conversation WHERE id = $1",
            conversation_id,
        )


async def claim_followup(kpi: asyncpg.Pool, conversation_id: int) -> bool:
    """Atomically claim the single follow-up slot for a conversation.

    Conditional UPDATE that only succeeds while agent_followup_at IS NULL, so two
    concurrent send jobs can never both send — the first flips NULL→now() and
    wins; the second matches no row and returns False. This is the same
    "claim-then-act" idiom as ack_alert. Returns True iff THIS call claimed the
    slot. The send job runs this AFTER its guards/generation (so a skip never
    burns the one touch) but BEFORE the actual WAHA send (so a crash mid-send
    still consumes the touch — never a duplicate nudge). Parametrized ($1)."""
    async with kpi.acquire() as conn:
        claimed = await conn.fetchval(
            """
            UPDATE conversation
            SET agent_followup_at = now()
            WHERE id = $1 AND agent_followup_at IS NULL
            RETURNING id
            """,
            conversation_id,
        )
    return claimed is not None


# ═══════════════════════════════════════════════════════════════════
# F3 OUTCALL — location capture read + outcall pricing inputs.
# All SQL parametrized (positional placeholders); JSONB getters are pure.
# ═══════════════════════════════════════════════════════════════════

# Default taxi surcharge percent when the casa `outcall` JSONB does not carry one
# (mirrors the seed scaffold's DEFAULT_SURCHARGE_PCT). Applied as 1 + pct/100.
_DEFAULT_TAXI_SURCHARGE_PCT: float = 20.0


# Outcall pricing only uses a FRESH location PIN. A pin shared in an earlier
# visit must not silently price a new request — the client sends their location
# during the same negotiation, so a 12h window is generous yet excludes stale pins.
_OUTCALL_LOCATION_MAX_AGE_HOURS = 12


async def get_latest_incoming_location(
    kpi: asyncpg.Pool,
    conv_id: int,
    max_age_hours: int = _OUTCALL_LOCATION_MAX_AGE_HOURS,
) -> tuple[float, float] | None:
    """Return the (latitude, longitude) of the LATEST RECENT incoming location
    message in a conversation, or None.

    Used by auto_reply to detect "the client just sent a location" — the
    deterministic trigger for an outcall quote. Only inbound (direction='in')
    rows with BOTH coords non-null AND sent within the last `max_age_hours`
    qualify (a stale pin from a prior visit must NOT price a fresh request); the
    most recent wins. Parametrized; bounded by LIMIT 1 over the conversation index.
    """
    async with kpi.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT latitude, longitude
            FROM message
            WHERE conversation_id = $1
              AND direction = 'in'
              AND latitude IS NOT NULL
              AND longitude IS NOT NULL
              AND created_at > now() - make_interval(hours => $2)
            ORDER BY created_at DESC
            LIMIT 1
            """,
            conv_id, max_age_hours,
        )
    if not row:
        return None
    return (float(row["latitude"]), float(row["longitude"]))


def get_outcall_base_eur(outcall: dict | None) -> float | None:
    """Typed getter for the casa `outcall` JSONB base price (euros), or None.

    The curated `outcall` shape is `{"base_price_eur": <num>, ...}` (see the
    seed scaffold). Returns None when the dict is missing, the key is absent, or
    the value is not a positive number — the caller treats None as "cannot quote
    an outcall, defer to reception". Pure + defensive (never raises)."""
    if not isinstance(outcall, dict):
        return None
    raw = outcall.get("base_price_eur")
    try:
        val = float(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return val if val > 0 else None


def get_outcall_taxi_buffer(outcall: dict | None) -> float:
    """Return the taxi-cost multiplier from the casa `outcall` JSONB.

    The stored field `taxi_surcharge_pct` is a PERCENT (e.g. 20 → x1.20). Falls
    back to the module default (20%) when missing/invalid. Pure; always returns a
    positive factor so the pricing never silently zeros the taxi cost."""
    pct = _DEFAULT_TAXI_SURCHARGE_PCT
    if isinstance(outcall, dict):
        raw = outcall.get("taxi_surcharge_pct")
        try:
            parsed = float(raw)  # type: ignore[arg-type]
            if parsed >= 0:
                pct = parsed
        except (TypeError, ValueError):
            pass
    return 1.0 + pct / 100.0



# ═══════════════════════════════════════════════════════════════════
# Casa style examples (Wave 2) — Sara learns from human receptionists.
# ═══════════════════════════════════════════════════════════════════
# A daily cron harvests real HUMAN outbound messages (direction='out' AND
# agent_generated=FALSE) per casa, pairs each with the client message it
# answered, and stores them as status='pending' for super-admin review. Approved
# rows are injected into Sara's system prompt as style guidance. All SQL
# parametrized; the casa link on `conversation` is the `casa_id` column.

# Harvest window + reply length sanity bounds (operational chatter / pasted blobs
# are not useful style examples). Tunable here, used by both the cron and tests.
_STYLE_HARVEST_DAYS = 30
_STYLE_REPLY_MIN_LEN = 3
_STYLE_REPLY_MAX_LEN = 240
# A 'pair' only forms when the client message preceded the reply within this gap
# (older context is unrelated → store the reply as a 'phrase' instead).
_STYLE_PAIR_MAX_GAP_MIN = 60


@dataclass(frozen=True)
class HarvestedReply:
    """One human reply candidate plus the client message it answered (if any,
    within _STYLE_PAIR_MAX_GAP_MIN). Raw from the DB — the caller sanitizes,
    classifies kind ('pair'/'phrase') and computes the dedup key."""
    reply_msg: str
    client_msg: str | None


async def fetch_human_replies_for_harvest(
    kpi: asyncpg.Pool, casa_id: int, limit: int = 200
) -> list[HarvestedReply]:
    """Recent HUMAN outbound replies for a casa, each with the client message it
    answered (latest 'in' before it, within the pair gap). Excludes Sara's sends
    (agent_generated=TRUE) and empty/media-only rows. Newest-first, capped."""
    async with kpi.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT
                m.body AS reply_msg,
                (
                    SELECT pm.body FROM message pm
                    WHERE pm.conversation_id = m.conversation_id
                      AND pm.direction = 'in'
                      AND pm.body IS NOT NULL AND pm.body <> ''
                      AND pm.created_at < m.created_at
                      AND pm.created_at >= m.created_at - make_interval(mins => $4)
                    ORDER BY pm.created_at DESC
                    LIMIT 1
                ) AS client_msg
            FROM message m
            JOIN conversation c ON c.id = m.conversation_id
            WHERE c.casa_id = $1
              AND m.direction = 'out'
              AND m.agent_generated = FALSE
              AND m.body IS NOT NULL AND m.body <> ''
              AND m.created_at >= now() - make_interval(days => $2)
            ORDER BY m.created_at DESC
            LIMIT $3
            """,
            casa_id, _STYLE_HARVEST_DAYS, limit, _STYLE_PAIR_MAX_GAP_MIN,
        )
    return [HarvestedReply(reply_msg=r["reply_msg"], client_msg=r["client_msg"]) for r in rows]


async def insert_style_example(
    kpi: asyncpg.Pool,
    *,
    casa_id: int,
    lang: str | None,
    kind: str,
    client_msg: str | None,
    reply_msg: str,
    dedup_key: str,
    source: str = "cron",
) -> bool:
    """Insert ONE pending style example. Idempotent: ON CONFLICT (casa_id,
    dedup_key) DO NOTHING. Returns True iff a new row was created."""
    async with kpi.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO casa_style_example
                (casa_id, lang, kind, client_msg, reply_msg, dedup_key, source)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (casa_id, dedup_key) DO NOTHING
            RETURNING id
            """,
            casa_id, lang, kind, client_msg, reply_msg, dedup_key, source,
        )
    return row is not None


@dataclass(frozen=True)
class StyleExample:
    """A style-example row for the review UI (joined with the casa name)."""
    id: int
    casa_id: int
    casa_name: str
    lang: str | None
    kind: str
    client_msg: str | None
    reply_msg: str
    status: str
    source: str
    created_at: datetime


async def list_style_examples(
    kpi: asyncpg.Pool, status: str = "pending", limit: int = 200
) -> list[StyleExample]:
    """List style examples by status (newest-first), joined with the casa name
    for the review page. Capped at `limit`."""
    async with kpi.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT e.id, e.casa_id, COALESCE(c.name, '—') AS casa_name,
                   e.lang, e.kind, e.client_msg, e.reply_msg, e.status,
                   e.source, e.created_at
            FROM casa_style_example e
            LEFT JOIN casa c ON c.id = e.casa_id
            WHERE e.status = $1
            ORDER BY e.casa_id, e.created_at DESC
            LIMIT $2
            """,
            status, limit,
        )
    return [
        StyleExample(
            id=r["id"], casa_id=r["casa_id"], casa_name=r["casa_name"],
            lang=r["lang"], kind=r["kind"], client_msg=r["client_msg"],
            reply_msg=r["reply_msg"], status=r["status"], source=r["source"],
            created_at=r["created_at"],
        )
        for r in rows
    ]


async def count_style_examples(kpi: asyncpg.Pool) -> dict[str, int]:
    """Counts per status ({'pending': n, 'approved': n, 'rejected': n}) for the
    review-page badges. Missing statuses default to 0."""
    async with kpi.acquire() as conn:
        rows = await conn.fetch(
            "SELECT status, count(*) AS n FROM casa_style_example GROUP BY status"
        )
    out = {"pending": 0, "approved": 0, "rejected": 0}
    for r in rows:
        out[r["status"]] = r["n"]
    return out


async def set_style_example_status(
    kpi: asyncpg.Pool, example_id: int, status: str
) -> bool:
    """Approve/reject one example. Sets decided_at=now(). Returns True iff a row
    was updated (idempotent: re-setting the same status still returns True)."""
    async with kpi.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE casa_style_example
            SET status = $2, decided_at = now()
            WHERE id = $1
            RETURNING id
            """,
            example_id, status,
        )
    return row is not None


@dataclass(frozen=True)
class StyleSample:
    """An APPROVED style example distilled for prompt injection (no metadata)."""
    kind: str
    client_msg: str | None
    reply_msg: str


_STYLE_TOKEN_RE = re.compile(r"[a-z0-9áéíóúñ]+", re.IGNORECASE)
# Pool of approved examples to rank in Python before picking the top `limit`.
_STYLE_POOL = 60


def _style_tokens(text: str | None) -> set[str]:
    """Lowercased, accent-folded word set (≥3 chars) for relevance scoring."""
    if not text:
        return set()
    folded = "".join(
        c for c in unicodedata.normalize("NFKD", text.lower())
        if not unicodedata.combining(c)
    )
    return {w for w in _STYLE_TOKEN_RE.findall(folded) if len(w) >= 3}


def rank_style_samples(
    samples: list["StyleSample"], incoming_text: str | None, limit: int
) -> list["StyleSample"]:
    """Pick the `limit` examples most RELEVANT to `incoming_text` (word overlap
    with the client message they answered), falling back to the given order
    (lang + recency) when there is no signal. Pure — exported for testing."""
    if not incoming_text or len(samples) <= limit:
        return samples[:limit]
    want = _style_tokens(incoming_text)
    if not want:
        return samples[:limit]
    # Stable sort by descending overlap; ties keep the input order (lang+recency).
    scored = sorted(
        enumerate(samples),
        key=lambda it: (
            -len(want & (_style_tokens(it[1].client_msg) | _style_tokens(it[1].reply_msg))),
            it[0],
        ),
    )
    return [s for _, s in scored[:limit]]


async def get_approved_style_examples(
    kpi: asyncpg.Pool,
    casa_id: int,
    lang: str | None,
    incoming_text: str | None = None,
    limit: int = 6,
) -> list[StyleSample]:
    """APPROVED style examples for a casa, preferring the reply language `lang`.

    Fetches a pool (lang-preferred, most-recent) then returns the `limit` examples
    most RELEVANT to `incoming_text` — so Sara sees how the team answered SIMILAR
    situations. With no incoming text it degrades to lang+recency. Empty list when
    the casa has no approved examples → caller injects nothing."""
    async with kpi.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT kind, client_msg, reply_msg
            FROM casa_style_example
            WHERE casa_id = $1 AND status = 'approved'
            ORDER BY (lang IS NOT DISTINCT FROM $2) DESC, created_at DESC
            LIMIT $3
            """,
            casa_id, lang, _STYLE_POOL,
        )
    samples = [
        StyleSample(kind=r["kind"], client_msg=r["client_msg"], reply_msg=r["reply_msg"])
        for r in rows
    ]
    return rank_style_samples(samples, incoming_text, limit)


# ═══════════════════════════════════════════════════════════════════
# Conversion outcome + A/B greeting variant (Wave 3).
# ═══════════════════════════════════════════════════════════════════
# The receptionist marks a conversation 'reservado' (the conversion signal); the
# A/B variant is assigned once on the first auto-reply. Both live on the
# `conversation` row (migration 0020). All SQL parametrized.

# The greeting A/B buckets. Kept here so the assigner (auto_reply) and the stats
# readout agree on the set; mirrors persona.AB_VARIANTS.
AB_VARIANTS: tuple[str, ...] = ("directa", "coqueta", "curiosa")


async def set_conversation_outcome(
    kpi: asyncpg.Pool, conversation_id: int, outcome: str | None, user_id: int | None
) -> bool:
    """Mark (or clear, outcome=None) a conversation's conversion outcome. Sets
    outcome_at=now() when marking, NULL when clearing. Returns True iff a row was
    updated."""
    async with kpi.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE conversation
            SET outcome = $2,
                outcome_at = CASE WHEN $2 IS NULL THEN NULL ELSE now() END,
                outcome_by_user_id = CASE WHEN $2 IS NULL THEN NULL ELSE $3 END
            WHERE id = $1
            RETURNING id
            """,
            conversation_id, outcome, user_id,
        )
    return row is not None


async def get_conversation_outcome(
    kpi: asyncpg.Pool, conversation_id: int
) -> str | None:
    """Return the conversation's outcome ('reservado') or None if unmarked."""
    async with kpi.acquire() as conn:
        return await conn.fetchval(
            "SELECT outcome FROM conversation WHERE id = $1", conversation_id
        )


async def assign_ab_variant(
    kpi: asyncpg.Pool, conversation_id: int, variant: str
) -> str | None:
    """Assign the greeting A/B variant ONCE (idempotent): keeps an existing value
    via COALESCE, else sets `variant`. Returns the effective variant (or None if
    the conversation row does not exist)."""
    async with kpi.acquire() as conn:
        return await conn.fetchval(
            """
            UPDATE conversation
            SET ab_variant = COALESCE(ab_variant, $2)
            WHERE id = $1
            RETURNING ab_variant
            """,
            conversation_id, variant,
        )


@dataclass(frozen=True)
class AbVariantStat:
    """A/B greeting readout row: conversations in a bucket + how many converted."""
    variant: str
    conversations: int
    conversions: int


async def ab_greeting_stats(kpi: asyncpg.Pool) -> list[AbVariantStat]:
    """Per-variant conversation + conversion counts (conversion = outcome set),
    for the A/B greeting readout. Only conversations actually in the test
    (ab_variant IS NOT NULL) are counted. Ordered by variant name."""
    async with kpi.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT ab_variant AS variant,
                   count(*)::int AS conversations,
                   count(*) FILTER (WHERE outcome IS NOT NULL)::int AS conversions
            FROM conversation
            WHERE ab_variant IS NOT NULL
            GROUP BY ab_variant
            ORDER BY ab_variant
            """
        )
    return [
        AbVariantStat(
            variant=r["variant"],
            conversations=r["conversations"],
            conversions=r["conversions"],
        )
        for r in rows
    ]


# ═══════════════════════════════════════════════════════════════════
# Per-line unread breakdown (navbar message-notification beep + mute).
# ═══════════════════════════════════════════════════════════════════
# Returns one row per WhatsApp line (wa_number.session, fallback casa.waha_session)
# with how many conversations on it are awaiting reply (last msg from client).
# The navbar JS compares consecutive polls and beeps when a non-muted line's count
# rises. All SQL parametrized; bounded to 30 days like the aggregate unread.


async def count_unread_by_number(kpi: asyncpg.Pool) -> list[dict]:
    """Per-line count of conversations whose last message is from the client.

    key   — the line identifier (session string), stable for the browser mute set.
    label — "casa · etiqueta" for display. unread — int count. Sorted by casa."""
    async with kpi.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT coalesce(wn.session, casa.waha_session) AS key,
                   casa.name AS casa_name,
                   wn.label  AS wa_label,
                   count(*)::int AS unread
            FROM conversation c
            JOIN casa ON casa.id = c.casa_id
            LEFT JOIN wa_number wn ON wn.id = c.wa_number_id
            WHERE c.last_message_at > now() - interval '30 days'
              AND (SELECT direction FROM message m WHERE m.conversation_id = c.id
                   ORDER BY m.created_at DESC LIMIT 1) = 'in'
              AND coalesce(wn.session, casa.waha_session) IS NOT NULL
            GROUP BY coalesce(wn.session, casa.waha_session), casa.name, wn.label
            ORDER BY casa.name NULLS LAST
            """
        )
    out: list[dict] = []
    for r in rows:
        label = r["casa_name"] or r["key"]
        if r["wa_label"]:
            label = f"{label} · {r['wa_label']}"
        out.append({"key": r["key"], "label": label, "unread": r["unread"]})
    return out


# ═══════════════════════════════════════════════════════════════════
# Live period volume (Métricas headline) — counted straight from the
# message/conversation tables so the 7d/30d/90d selector actually moves
# the numbers (unlike the AI-informe snapshot, which is a fixed window).
# ═══════════════════════════════════════════════════════════════════


async def period_volume(kpi: asyncpg.Pool, days: int) -> dict:
    """Live volume KPIs over the last `days`, per casa + overall.

    Returns {"overall": {convs,msgs_in,msgs_out,p50_sec}, "by_casa": [{...}]}.
    convs = distinct conversations with a message in the window; msgs_in/out =
    message counts by direction; p50_sec = median seconds from a client message to
    the next reply (capped at 6h, so a next-day reply isn't counted as a response).
    Fail-soft: returns zeros on ANY error so the Métricas page never 500s."""
    overall = {"convs": 0, "msgs_in": 0, "msgs_out": 0, "p50_sec": None}
    by_casa: list[dict] = []
    try:
        async with kpi.acquire() as conn:
            counts = await conn.fetch(
                """
                SELECT c.casa_id AS casa_id, max(ca.name) AS casa_name,
                       count(DISTINCT c.id)                   AS convs,
                       count(*) FILTER (WHERE m.direction='in')  AS msgs_in,
                       count(*) FILTER (WHERE m.direction='out') AS msgs_out
                FROM message m
                JOIN conversation c ON c.id = m.conversation_id
                JOIN casa ca ON ca.id = c.casa_id
                WHERE m.created_at > now() - make_interval(days => $1)
                GROUP BY ROLLUP (c.casa_id)
                """,
                days,
            )
            resp = await conn.fetch(
                """
                WITH paired AS (
                    SELECT c.casa_id AS casa_id,
                           extract(epoch FROM (m.created_at - (
                               SELECT max(mi.created_at) FROM message mi
                               WHERE mi.conversation_id = m.conversation_id
                                 AND mi.direction = 'in'
                                 AND mi.created_at < m.created_at
                           )))::float AS gap_sec
                    FROM message m
                    JOIN conversation c ON c.id = m.conversation_id
                    WHERE m.direction = 'out'
                      AND m.created_at > now() - make_interval(days => $1)
                )
                SELECT casa_id,
                       percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_sec) AS p50
                FROM paired
                WHERE gap_sec IS NOT NULL AND gap_sec > 0 AND gap_sec < 21600
                GROUP BY ROLLUP (casa_id)
                """,
                days,
            )
        p50_by = {
            r["casa_id"]: (int(r["p50"]) if r["p50"] is not None else None) for r in resp
        }
        for r in counts:
            rec = {
                "casa_id": r["casa_id"],
                "name": r["casa_name"],
                "convs": int(r["convs"] or 0),
                "msgs_in": int(r["msgs_in"] or 0),
                "msgs_out": int(r["msgs_out"] or 0),
                "p50_sec": p50_by.get(r["casa_id"]),
            }
            if r["casa_id"] is None:
                overall = {k: rec[k] for k in ("convs", "msgs_in", "msgs_out", "p50_sec")}
            else:
                by_casa.append(rec)
        by_casa.sort(key=lambda x: x["convs"], reverse=True)
    except Exception:  # noqa: BLE001 — metrics must never 500 the page
        return {"overall": overall, "by_casa": []}
    return {"overall": overall, "by_casa": by_casa}
