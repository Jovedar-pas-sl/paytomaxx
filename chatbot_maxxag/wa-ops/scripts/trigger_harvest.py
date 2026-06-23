#!/usr/bin/env python3
"""Harvest human-receptionist replies into style-example candidates ONCE, now
(no waiting for the nightly cron). Populates `casa_style_example` as 'pending'
for review under /ajustes/estilo (Wave 2).

Run inside the kpi-app (or kpi-worker) container, where DATABASE_URL is in the
env and the `app` package is importable:

    docker compose cp scripts/trigger_harvest.py kpi-app:/tmp/trigger_harvest.py
    docker compose exec -u root -T kpi-app python /tmp/trigger_harvest.py

Prints the number of new candidates inserted per casa.
"""
from __future__ import annotations

import asyncio
import logging
import os
import sys

import asyncpg

from app import queries
from app.agent import style_harvest


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
        casas = await queries.list_casas(pool)
        total = 0
        for casa in casas:
            n = await style_harvest.harvest_casa(pool, casa.account_id)
            total += n
            print(f"  casa {casa.account_id}: +{n} candidate(s)")
        print(f"DONE: {total} new style-example candidate(s) → review at /ajustes/estilo")
    finally:
        await pool.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
