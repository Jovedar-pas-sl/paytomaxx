#!/usr/bin/env python3
"""Dump the Madrid receptionist's REAL replies (client message -> her reply), so
we can distill her style into Sara's persona by hand. READ-ONLY — prints only,
writes nothing to the DB.

Self-contained: runs its own SQL (no dependency on the harvest query), so it
works with whatever code is currently deployed. Each line is sanitized
(phones/URLs stripped) via app.agent.style_harvest.scrub.

Run inside the kpi-app (or kpi-worker) container, from /app so `app` imports:

    docker compose cp scripts/dump_madrid_style.py kpi-app:/app/dump_madrid_style.py
    docker compose exec -u root -T kpi-app python /app/dump_madrid_style.py
"""
from __future__ import annotations

import asyncio
import os
import sys

if "/app" not in sys.path:  # make `app` importable when run outside WORKDIR
    sys.path.insert(0, "/app")

import asyncpg

from app.agent import style_harvest

_WINDOW_DAYS = 90        # how far back to look
_MAX_PER_CASA = 120      # cap printed examples per casa
_PAIR_GAP_MIN = 60       # client msg must precede the reply within this gap

_SQL = """
    SELECT
        m.body AS reply_msg,
        (
            SELECT pm.body FROM message pm
            WHERE pm.conversation_id = m.conversation_id
              AND pm.direction = 'in'
              AND pm.body IS NOT NULL AND pm.body <> ''
              AND pm.created_at < m.created_at
              AND pm.created_at >= m.created_at - make_interval(mins => $2)
            ORDER BY pm.created_at DESC
            LIMIT 1
        ) AS client_msg
    FROM message m
    JOIN conversation c ON c.id = m.conversation_id
    WHERE c.casa_id = $1
      AND m.direction = 'out'
      AND m.agent_generated = FALSE
      AND m.body IS NOT NULL AND m.body <> ''
      AND m.created_at >= now() - make_interval(days => $3)
    ORDER BY m.created_at DESC
    LIMIT 600
"""


async def main() -> int:
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("ERROR: DATABASE_URL not set", file=sys.stderr)
        return 2
    scheme, sep, rest = dsn.partition("://")
    dsn = f"{scheme.split('+', 1)[0]}{sep}{rest}" if sep else dsn

    pool = await asyncpg.create_pool(dsn, min_size=1, max_size=2)
    try:
        async with pool.acquire() as conn:
            casas = await conn.fetch(
                "SELECT id, name FROM casa WHERE name ILIKE '%madrid%' ORDER BY id"
            )
            if not casas:
                print("No se encontró ninguna casa con 'madrid' en el nombre.")
                # Help the operator: list the casas that DO exist.
                allc = await conn.fetch("SELECT id, name FROM casa ORDER BY id")
                print("Casas disponibles:")
                for c in allc:
                    print(f"  id {c['id']}: {c['name']}")
                return 0

            for casa in casas:
                cid, cname = casa["id"], casa["name"]
                print(f"\n===== {cname} (id {cid}) =====")
                rows = await conn.fetch(_SQL, cid, _PAIR_GAP_MIN, _WINDOW_DAYS)
                seen: set[str] = set()
                shown = 0
                for r in rows:
                    reply = style_harvest.scrub(r["reply_msg"] or "", 400)
                    if len(reply) < 3:
                        continue
                    key = style_harvest.dedup_key(reply)
                    if key in seen:
                        continue
                    seen.add(key)
                    client = (
                        style_harvest.scrub(r["client_msg"] or "", 200)
                        if r["client_msg"]
                        else ""
                    )
                    if client:
                        print(f"C: {client}")
                    print(f"S: {reply}")
                    print()
                    shown += 1
                    if shown >= _MAX_PER_CASA:
                        break
                print(f"----- {shown} ejemplos de {cname} -----")
    finally:
        await pool.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
