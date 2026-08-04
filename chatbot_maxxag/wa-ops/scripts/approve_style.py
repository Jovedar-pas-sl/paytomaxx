#!/usr/bin/env python3
"""Aprobar en bloque los ejemplos de estilo PENDIENTES de una o varias casas.

Aprueba (status='approved', decided_at=now()) TODOS los 'pending' de las casas
cuyo nombre contenga el texto dado (case-insensitive). Solo afecta filas
status='pending' — nunca toca approved/rejected. Imprime qué casas y cuántos.

Uso (dentro del contenedor kpi-app, donde DATABASE_URL está en el env):

    docker compose cp scripts/approve_style.py kpi-app:/tmp/approve_style.py
    # ver cuántos se aprobarían SIN tocar nada:
    docker compose exec -u root -T kpi-app python /tmp/approve_style.py madrid --dry-run
    # aprobar de verdad:
    docker compose exec -u root -T kpi-app python /tmp/approve_style.py madrid
"""
from __future__ import annotations

import asyncio
import os
import sys

import asyncpg


def _dsn() -> str | None:
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        return None
    scheme, sep, rest = dsn.partition("://")
    return f"{scheme.split('+', 1)[0]}{sep}{rest}" if sep else dsn


async def main() -> int:
    args = [a for a in sys.argv[1:]]
    dry = "--dry-run" in args
    needles = [a for a in args if not a.startswith("--")]
    if not needles:
        print("Uso: approve_style.py <substring-nombre-casa> [--dry-run]", file=sys.stderr)
        return 2
    needle = needles[0]

    dsn = _dsn()
    if not dsn:
        print("ERROR: DATABASE_URL not set", file=sys.stderr)
        return 2

    pool = await asyncpg.create_pool(dsn, min_size=1, max_size=2)
    try:
        async with pool.acquire() as c:
            casas = await c.fetch(
                "SELECT id, name FROM casa WHERE name ILIKE '%' || $1 || '%' ORDER BY name",
                needle,
            )
            if not casas:
                print(f"No hay casa cuyo nombre contenga '{needle}'.")
                return 1

            print(f"{'(DRY-RUN) ' if dry else ''}Casas que coinciden con '{needle}':")
            total = 0
            for casa in casas:
                pend = await c.fetchval(
                    "SELECT count(*) FROM casa_style_example "
                    "WHERE casa_id = $1 AND status = 'pending'",
                    casa["id"],
                )
                if dry:
                    print(f"  - {casa['name']:<24} se aprobarían: {pend}")
                    total += pend
                    continue
                done = await c.fetchval(
                    """
                    WITH upd AS (
                        UPDATE casa_style_example
                        SET status = 'approved', decided_at = now()
                        WHERE casa_id = $1 AND status = 'pending'
                        RETURNING 1
                    )
                    SELECT count(*) FROM upd
                    """,
                    casa["id"],
                )
                print(f"  - {casa['name']:<24} aprobados: {done}")
                total += done

            print(f"{'(DRY-RUN) total que se aprobaría' if dry else 'TOTAL aprobado'}: {total}")
            if dry:
                print("Quita --dry-run para aplicarlo.")
    finally:
        await pool.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
