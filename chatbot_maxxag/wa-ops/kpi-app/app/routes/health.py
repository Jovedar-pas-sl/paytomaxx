"""Health + small JSON helper endpoints for the navbar (unread badge)."""

from __future__ import annotations

from fastapi import APIRouter

from app.deps import CurrentUser, KpiDB, Redis

router = APIRouter()


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
) -> dict:
    """Live count of conversations awaiting reply + active critical alerts.

    Polled by the navbar badge every ~30s.  Returns:
      {
        unread_chats: N,        # conversations whose last msg is from client
        critical_alerts: N,     # unack'd alerts of type escalation/red_flag
      }
    """
    async with db.acquire() as conn:
        unread = await conn.fetchval(
            """
            SELECT count(*)
            FROM conversation c
            WHERE (SELECT direction FROM message m WHERE m.conversation_id = c.id
                   ORDER BY m.created_at DESC LIMIT 1) = 'in'
            """
        ) or 0
        crit = await conn.fetchval(
            """
            SELECT count(*) FROM alert
            WHERE acknowledged_at IS NULL
              AND type IN ('escalation','red_flag')
              AND severity IN ('critical','high','warning')
            """
        ) or 0
    return {"unread_chats": int(unread), "critical_alerts": int(crit)}
