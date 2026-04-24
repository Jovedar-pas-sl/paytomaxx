"""FastAPI dependencies: DB pools, Redis pool, current_user."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING, Annotated

import asyncpg
import redis.asyncio as redis_async
from arq import create_pool
from arq.connections import ArqRedis, RedisSettings
from fastapi import Depends, FastAPI, HTTPException, Request, status

from app.settings import Settings, get_settings
from app.waha_client import WahaClient

if TYPE_CHECKING:
    from app.models import AdminUser


class AppState:
    """Holds DB, Redis, Arq, and WAHA clients for the lifetime of the app."""

    kpi_db: asyncpg.Pool
    redis: redis_async.Redis
    arq: ArqRedis
    waha: WahaClient


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """FastAPI lifespan: open pools on startup, close on shutdown."""
    settings = get_settings()
    state = AppState()

    state.kpi_db = await asyncpg.create_pool(
        dsn=settings.database_url,
        min_size=2,
        max_size=10,
        command_timeout=30,
    )
    state.redis = redis_async.from_url(settings.redis_url, decode_responses=True)
    state.arq = await create_pool(RedisSettings.from_dsn(settings.redis_url))
    state.waha = WahaClient(settings)

    app.state.pools = state
    try:
        yield
    finally:
        await state.waha.aclose()
        await state.kpi_db.close()
        await state.redis.aclose()
        await state.arq.close()


# ── Pool dependencies ──────────────────────────────────────────────
async def get_kpi_db(request: Request) -> asyncpg.Pool:
    return request.app.state.pools.kpi_db


async def get_redis(request: Request) -> redis_async.Redis:
    return request.app.state.pools.redis


async def get_arq(request: Request) -> ArqRedis:
    return request.app.state.pools.arq


async def get_waha(request: Request) -> WahaClient:
    return request.app.state.pools.waha


KpiDB = Annotated[asyncpg.Pool, Depends(get_kpi_db)]
Redis = Annotated[redis_async.Redis, Depends(get_redis)]
Arq = Annotated[ArqRedis, Depends(get_arq)]
Waha = Annotated[WahaClient, Depends(get_waha)]
SettingsDep = Annotated[Settings, Depends(get_settings)]


# ── Auth dependency ────────────────────────────────────────────────
async def get_current_user(request: Request) -> "AdminUser":
    """Verify JWT cookie and return the admin user, else 401."""
    from app.auth import decode_token  # local import to avoid circulars
    from app.models import AdminUser

    token = request.cookies.get("maxxag_kpi_auth")
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
        )
    try:
        claims = decode_token(token)
    except Exception as exc:  # noqa: BLE001 — JWT lib raises many types
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid session",
        ) from exc
    return AdminUser(email=claims["sub"])


CurrentUser = Annotated["AdminUser", Depends(get_current_user)]
