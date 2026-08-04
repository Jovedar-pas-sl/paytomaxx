#!/usr/bin/env python3
"""Volcado SOLO-LECTURA de las respuestas REALES de las encargadas, por casa.

Objetivo: extraer las respuestas humanas (no las de Sara) que llevan INFORMACIÓN
—precios, dirección/ubicación, servicios y extras, salidas/domicilio + taxi,
horarios, pago— para poder INTERPRETARLAS y construir el conocimiento de cada
casa que Sara debería tener.

Qué cuenta como "de la encargada": message.direction='out' AND agent_generated=FALSE
(o sea, NO las respuestas automáticas de Sara). Se filtran las triviales ("ok",
"vale", "gracias"), se deduplican las casi-idénticas y se recortan a las N más
informativas por casa (por defecto 60).

Ejecutar dentro del contenedor kpi-app (donde DATABASE_URL está en el env):

    docker compose cp scripts/dump_encargada_replies.py kpi-app:/tmp/dump.py
    docker compose exec -u root -T kpi-app python /tmp/dump.py            # todas las casas, 60/casa
    docker compose exec -u root -T kpi-app python /tmp/dump.py 7          # solo casa_id=7
    docker compose exec -u root -T kpi-app python /tmp/dump.py 7 120      # casa 7, 120 respuestas

Solo hace SELECTs. No modifica nada. Pega la salida y la interpreto.
"""
from __future__ import annotations

import asyncio
import os
import re
import sys

import asyncpg

# Palabras que marcan una respuesta como INFORMATIVA (precio/sitio/servicios/…).
# Se buscan como PALABRA COMPLETA sobre el texto en minúsculas y sin acentos (así
# 'hora' no casa dentro de 'ahora', 'bajo' no casa en 'trabajo', etc.).
_INFO_WORDS = (
    "euro", "eur", "precio", "precios", "tarifa", "tarifas", "cuesta",
    "calle", "avenida", "avda", "direccion", "ubicacion", "estamos",
    "portal", "puerta", "planta", "piso", "bajo", "local", "timbre", "timbra",
    "salida", "salidas", "domicilio", "hotel", "taxi", "desplazamiento",
    "servicio", "servicios", "frances", "griego", "beso", "negro", "lluvia",
    "dorada", "masaje", "masajes", "ducha", "pareja", "duplex", "duo",
    "hora", "horas", "minutos", "min", "1h", "24h", "abierto", "abrimos",
    "cerramos", "efectivo", "tarjeta", "bizum", "pago", "reserva", "reservar",
    "disponible", "disponibles",
)
_INFO_RE = re.compile(r"\b(" + "|".join(re.escape(w) for w in _INFO_WORDS) + r")\b")
# Símbolos/fragmentos que se buscan como SUBSTRING (no aplican límites de palabra).
_INFO_SUBSTR = ("€", "c/")

_TRIVIAL = {
    "ok", "vale", "si", "sí", "no", "gracias", "hola", "buenas", "adios",
    "adiós", "👍", "😘", "😉", "ahora", "ya", "voy", "espera", "un momento",
    "dime", "claro", "perfecto", "genial", "jaja", "jeje",
}


def _dsn() -> str | None:
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        return None
    scheme, sep, rest = dsn.partition("://")
    return f"{scheme.split('+', 1)[0]}{sep}{rest}" if sep else dsn


def _fold(text: str) -> str:
    import unicodedata
    nfkd = unicodedata.normalize("NFKD", text.lower())
    return "".join(c for c in nfkd if not unicodedata.combining(c))


def _norm_key(text: str) -> str:
    """Dedup key: folded + TODO lo no-alfanumérico/€ eliminado → une casi-idénticas
    ('150€!!' == '150 €'). No importa que las palabras queden pegadas: es una clave."""
    return re.sub(r"[^a-z0-9€]+", "", _fold(text))


def _is_informative(body: str) -> bool:
    b = (body or "").strip()
    if len(b) < 8:
        return False
    folded = _fold(b)
    if folded.strip(" .!?¡¿") in _TRIVIAL:
        return False
    if any(s in folded for s in _INFO_SUBSTR) or _INFO_RE.search(folded):
        return True
    # Substancial aunque no tenga keyword (frases largas suelen llevar info).
    return len(b) >= 60


async def _casas(conn: asyncpg.Connection, only: int | None) -> list[asyncpg.Record]:
    if only is not None:
        return await conn.fetch(
            "SELECT id, name FROM casa WHERE id = $1", only)
    return await conn.fetch("SELECT id, name FROM casa ORDER BY id")


async def main() -> int:
    args = [a for a in sys.argv[1:] if a.isdigit()]
    only_casa = int(args[0]) if len(args) >= 1 else None
    per_casa = int(args[1]) if len(args) >= 2 else 60

    dsn = _dsn()
    if not dsn:
        print("ERROR: DATABASE_URL not set", file=sys.stderr)
        return 2
    pool = await asyncpg.create_pool(dsn, min_size=1, max_size=2)
    try:
        async with pool.acquire() as c:
            casas = await _casas(c, only_casa)
            print("=" * 72)
            print("  RESPUESTAS DE LAS ENCARGADAS (humanas, con info) — por casa")
            print(f"  (máx {per_casa} por casa, deduplicadas)")
            print("=" * 72)
            for casa in casas:
                # Traer un buen lote de respuestas HUMANAS recientes; el filtrado +
                # dedup se hace en Python (más flexible que en SQL).
                rows = await c.fetch(
                    """
                    SELECT m.body, m.created_at
                    FROM message m
                    JOIN conversation co ON co.id = m.conversation_id
                    WHERE co.casa_id = $1
                      AND m.direction = 'out'
                      AND m.agent_generated = FALSE
                      AND m.body IS NOT NULL AND length(trim(m.body)) > 0
                    ORDER BY m.created_at DESC
                    LIMIT 3000
                    """,
                    casa["id"],
                )
                total_human = len(rows)
                seen: set[str] = set()
                picked: list[str] = []
                for r in rows:
                    body = (r["body"] or "").strip()
                    if not _is_informative(body):
                        continue
                    key = _norm_key(body)
                    if not key or key in seen:
                        continue
                    seen.add(key)
                    picked.append(body)
                    if len(picked) >= per_casa:
                        break

                print(f"\n{'─' * 72}")
                print(f"### CASA {casa['id']} — {casa['name']}   "
                      f"(humanas recientes: {total_human}, informativas únicas: {len(picked)})")
                print("─" * 72)
                if not picked:
                    print("  (sin respuestas humanas informativas)")
                    continue
                for i, body in enumerate(picked, 1):
                    one_line = re.sub(r"\s+", " ", body).strip()
                    print(f"{i:>3}. {one_line}")
            print("\n" + "=" * 72)
    finally:
        await pool.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
