"""Health check endpoint — used by Docker healthcheck and monitoring."""

from __future__ import annotations

from fastapi import APIRouter

from app.deps import KpiDB, Redis

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
