#!/usr/bin/env python3
"""Informe SOLO-LECTURA: ¿qué ha aprendido Sara esta semana?

Resume el aprendizaje de estilo (casa_style_example), la actividad real de Sara
(message.agent_generated) y la memoria por cliente (conversation_memory) en una
ventana de N días (por defecto 7).

Ejecutar dentro del contenedor kpi-app (donde DATABASE_URL está en el env):

    docker compose cp scripts/sara_learning_report.py kpi-app:/tmp/sara_report.py
    docker compose exec -u root -T kpi-app python /tmp/sara_report.py        # 7 días
    docker compose exec -u root -T kpi-app python /tmp/sara_report.py 30     # 30 días

Solo hace SELECTs. No modifica nada.
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


async def _table_exists(conn: asyncpg.Connection, name: str) -> bool:
    return bool(await conn.fetchval("SELECT to_regclass($1)", name))


async def main() -> int:
    days = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 7
    dsn = _dsn()
    if not dsn:
        print("ERROR: DATABASE_URL not set", file=sys.stderr)
        return 2
    pool = await asyncpg.create_pool(dsn, min_size=1, max_size=2)
    try:
        async with pool.acquire() as c:
            print("=" * 64)
            print(f"  INFORME DE APRENDIZAJE DE SARA — últimos {days} días")
            print("=" * 64)

            # ── 1) Aprendizaje de estilo (de las encargadas) ──────────────
            print("\n[1] APRENDIZAJE DE ESTILO (de las encargadas)")
            if not await _table_exists(c, "casa_style_example"):
                print("  ⚠️  tabla casa_style_example no existe (migración 0019 sin aplicar)")
            else:
                tot = {r["status"]: r["n"] for r in await c.fetch(
                    "SELECT status, count(*) n FROM casa_style_example GROUP BY status")}
                print(f"  Totales:      pending={tot.get('pending',0)}  "
                      f"approved={tot.get('approved',0)}  rejected={tot.get('rejected',0)}")
                new_week = await c.fetchval(
                    "SELECT count(*) FROM casa_style_example "
                    "WHERE created_at >= now() - make_interval(days => $1)", days)
                appr_week = await c.fetchval(
                    "SELECT count(*) FROM casa_style_example WHERE status='approved' "
                    "AND decided_at >= now() - make_interval(days => $1)", days)
                last_cron = await c.fetchval(
                    "SELECT max(created_at) FROM casa_style_example WHERE source='cron'")
                print(f"  Cosechados esta ventana: {new_week}   "
                      f"Aprobados esta ventana: {appr_week}")
                print(f"  Última cosecha cron:     {last_cron}")
                rows = await c.fetch(
                    """
                    SELECT COALESCE(ca.name,'casa '||e.casa_id) AS casa,
                           count(*) FILTER (WHERE e.status='approved') AS approved,
                           count(*) FILTER (WHERE e.status='pending')  AS pending
                    FROM casa_style_example e
                    LEFT JOIN casa ca ON ca.id = e.casa_id
                    GROUP BY casa ORDER BY approved DESC, pending DESC
                    """)
                print("  Por casa (approved = lo que SÍ usa Sara en el prompt):")
                if not rows:
                    print("    (sin ejemplos todavía)")
                for r in rows:
                    print(f"    - {r['casa']:<24} approved={r['approved']:<4} pending={r['pending']}")

            # ── 2) Sara contestando de verdad ─────────────────────────────
            print(f"\n[2] SARA CONTESTANDO (mensajes que envió, últimos {days} días)")
            total_repl = await c.fetchval(
                "SELECT count(*) FROM message "
                "WHERE direction='out' AND agent_generated=TRUE "
                "AND created_at >= now() - make_interval(days => $1)", days)
            convs = await c.fetchval(
                "SELECT count(DISTINCT conversation_id) FROM message "
                "WHERE direction='out' AND agent_generated=TRUE "
                "AND created_at >= now() - make_interval(days => $1)", days)
            prev = await c.fetchval(
                "SELECT count(*) FROM message WHERE direction='out' AND agent_generated=TRUE "
                "AND created_at >= now() - make_interval(days => $1) "
                "AND created_at <  now() - make_interval(days => $2)", days * 2, days)
            print(f"  Respuestas de Sara: {total_repl}   (semana previa: {prev})")
            print(f"  Conversaciones atendidas por Sara: {convs}")
            per_casa = await c.fetch(
                """
                SELECT COALESCE(ca.name,'casa '||co.casa_id) AS casa, count(*) AS n
                FROM message m
                JOIN conversation co ON co.id = m.conversation_id
                LEFT JOIN casa ca ON ca.id = co.casa_id
                WHERE m.direction='out' AND m.agent_generated=TRUE
                  AND m.created_at >= now() - make_interval(days => $1)
                GROUP BY casa ORDER BY n DESC
                """, days)
            for r in per_casa:
                print(f"    - {r['casa']:<24} {r['n']} respuestas")
            if not per_casa:
                print("    (Sara no envió ninguna respuesta automática en la ventana)")

            # ── 3) Memoria por cliente ────────────────────────────────────
            print(f"\n[3] MEMORIA POR CLIENTE (idioma + chicas preferidas)")
            if not await _table_exists(c, "conversation_memory"):
                print("  ⚠️  tabla conversation_memory no existe (migración 0015 sin aplicar)")
            else:
                mtot = await c.fetchval("SELECT count(*) FROM conversation_memory")
                mweek = await c.fetchval(
                    "SELECT count(*) FROM conversation_memory "
                    "WHERE updated_at >= now() - make_interval(days => $1)", days)
                with_lang = await c.fetchval(
                    "SELECT count(*) FROM conversation_memory WHERE preferred_lang IS NOT NULL")
                with_girls = await c.fetchval(
                    "SELECT count(*) FROM conversation_memory "
                    "WHERE preferred_girls IS NOT NULL AND array_length(preferred_girls,1) > 0")
                print(f"  Clientes con memoria: {mtot}   (actualizados esta ventana: {mweek})")
                print(f"  Con idioma recordado: {with_lang}   con chicas preferidas: {with_girls}")
                langs = await c.fetch(
                    "SELECT preferred_lang, count(*) n FROM conversation_memory "
                    "WHERE preferred_lang IS NOT NULL GROUP BY preferred_lang ORDER BY n DESC")
                if langs:
                    dist = "  ".join(f"{r['preferred_lang']}={r['n']}" for r in langs)
                    print(f"  Idiomas detectados/recordados: {dist}")

            print("\n" + "=" * 64)
    finally:
        await pool.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
