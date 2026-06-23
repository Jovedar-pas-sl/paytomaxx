"""Health + small JSON helper endpoints for the navbar (unread badge)."""

from __future__ import annotations

from typing import TypedDict

from fastapi import APIRouter

from app import queries
from app.deps import CurrentUser, KpiDB, Redis

router = APIRouter()


class UnreadCounts(TypedDict):
    """Shape of the /api/unread-count payload polled by the navbar / Sara badge."""

    unread_chats: int
    critical_alerts: int
    paused_risk: int
    pending_suggestions: int
    hot_leads: int
    sara_auto: int
    sara_copilot: int
    sara_off: int
    by_number: list[dict]


@router.get("/health")
async def health(db: KpiDB, redis: Redis) -> dict[str, str]:
    # Light touch on each dependency
    try:
        async with db.acquire() as conn:
            await conn.fetchval("SELECT 1")
    except Exception:  # noqa: BLE001
        return {"status": "degraded", "db": "down"}
    try:
        await redis.ping()
    except Exception:  # noqa: BLE001
        return {"status": "degraded", "redis": "down"}
    return {"status": "ok"}


@router.get("/api/unread-count")
async def unread_count(
    user: CurrentUser,  # noqa: ARG001
    db: KpiDB,
) -> UnreadCounts:
    """Live count of conversations awaiting reply + active critical alerts +
    Sara inbox-awareness signals.

    Polled by the navbar badge / Sara header indicator every ~20-30s.  Returns:
      {
        unread_chats: N,         # conversations whose last msg is from client
        critical_alerts: N,      # de-noised actionable alerts (see queries)
        paused_risk: N,          # unacked alerts where the bot HALTED (urgent)
        pending_suggestions: N,  # unacked copilot drafts waiting (silent)
        hot_leads: N,            # open convs with conv_probability >= threshold
      }

    The critical_alerts count shares the single de-noised source of truth with
    the dashboard headline (queries.count_critical_alerts) so the nav badge and
    the 'Estado casas' KPI never disagree. The three inbox-awareness counters
    are returned SEPARATELY so the front end can apply the strict sound policy
    (sound only when paused_risk or hot_leads increases).
    """
    # Bounded by last 30 days to keep the cost predictable as the table grows.
    # Single-tenant deployment so no per-user filter is needed today; if ever
    # multi-tenant, this should JOIN casa.owner_id = user.id.
    async with db.acquire() as conn:
        unread = await conn.fetchval(
            """
            SELECT count(*)
            FROM conversation c
            WHERE c.last_message_at > now() - interval '30 days'
              AND (SELECT direction FROM message m WHERE m.conversation_id = c.id
                   ORDER BY m.created_at DESC LIMIT 1) = 'in'
            """
        ) or 0
    crit = await queries.count_critical_alerts(db)
    attention = await queries.count_inbox_attention(db)
    modes = await queries.count_wa_modes(db)
    by_number = await queries.count_unread_by_number(db)
    return {
        "unread_chats": int(unread),
        "critical_alerts": int(crit),
        "paused_risk": attention.paused_risk,
        "pending_suggestions": attention.pending_suggestions,
        "hot_leads": attention.hot_leads,
        "sara_auto": modes["auto"],
        "sara_copilot": modes["copilot"],
        "sara_off": modes["off"],
        "by_number": by_number,
    }
