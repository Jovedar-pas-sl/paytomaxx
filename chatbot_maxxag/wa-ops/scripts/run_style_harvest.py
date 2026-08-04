#!/usr/bin/env python3
"""Dispara el harvest de estilo AL MOMENTO (sin esperar al cron de las 04:30).

Recorre todas las casas, cosecha las respuestas reales de las encargadas y
AUTO-APRUEBA las que se repiten (>= STYLE_AUTO_APPROVE_MIN, por defecto 3) — el bot
aprende ya lo que el equipo dice de forma consistente, y promueve el backlog de
'pending' recurrente. Solo lee + upsert; no manda nada.

⚠️ Importa el paquete `app`, así que hay que correrlo DESDE /app (no /tmp) y con el
código nuevo YA desplegado:

    docker compose cp scripts/run_style_harvest.py kpi-app:/app/_harvest.py
    docker compose exec -u root -T kpi-app python /app/_harvest.py
    # umbral distinto para esta pasada:
    docker compose exec -u root -T -e STYLE_AUTO_APPROVE_MIN=2 kpi-app python /app/_harvest.py
"""
from __future__ import annotations

import asyncio
import os

import asyncpg

from app import queries
from app.agent import style_harvest


def _dsn() -> str | None:
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        return None
    scheme, sep, rest = dsn.partition("://")
    return f"{scheme.split('+', 1)[0]}{sep}{rest}" if sep else dsn


async def main() -> int:
    dsn = _dsn()
    if not dsn:
        print("ERROR: DATABASE_URL not set")
        return 2
    print(f"Umbral auto-aprobación (repeticiones): {style_harvest._AUTO_APPROVE_MIN}")
    pool = await asyncpg.create_pool(dsn, min_size=1, max_size=2)
    try:
        before = await queries.count_style_examples(pool)
        casas = await queries.list_casas(pool)
        total = 0
        for casa in casas:
            name = getattr(casa, "account_name", "") or ""
            try:
                n = await style_harvest.harvest_casa(pool, casa.account_id)
                total += n
                print(f"  casa {casa.account_id:>3} {name:<24} +{n} nuevas")
            except Exception as exc:  # noqa: BLE001 — una casa no debe tumbar el resto
                print(f"  casa {casa.account_id:>3} {name:<24} ERROR: {exc}")
        after = await queries.count_style_examples(pool)
        print(f"\nNuevas insertadas: {total}")
        print(f"Ejemplos antes:  {before}")
        print(f"Ejemplos ahora:  {after}")
        print("(approved = lo que Sara YA usa como estilo del equipo)")
    finally:
        await pool.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
