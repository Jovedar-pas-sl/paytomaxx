#!/usr/bin/env python3
"""Run the website->DB knowledge sync ONCE, now (no waiting for the 20-min cron).

Run inside the kpi-app (or kpi-worker) container, where DATABASE_URL is in the
env and the `app` package is importable:

    docker compose cp scripts/trigger_sync.py kpi-app:/tmp/trigger_sync.py
    docker compose exec -u root -T kpi-app python /tmp/trigger_sync.py

Prints website_sync's run summary (casas synced, girls upserted/deactivated).
"""
from __future__ import annotations

import asyncio
import logging
import os
import sys

import asyncpg
import httpx

from app.agent import website_sync


async def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("ERROR: DATABASE_URL not set", file=sys.stderr)
        return 2
    scheme, sep, rest = dsn.partition("://")
    dsn = f"{scheme.split('+', 1)[0]}{sep}{rest}" if sep else dsn

    pool = await asyncpg.create_pool(dsn, min_size=1, max_size=2)
    try:
        async with httpx.AsyncClient(timeout=15.0) as http:
            await website_sync.sync_all(pool, http)
    finally:
        await pool.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
