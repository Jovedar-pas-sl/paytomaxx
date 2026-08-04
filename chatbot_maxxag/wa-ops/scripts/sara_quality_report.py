#!/usr/bin/env python3
"""Sonda de CALIDAD de Sara — juez IA sobre conversaciones REALES (solo lectura).

Coge respuestas reales de Sara (agent_generated=TRUE) con el mensaje del cliente que
contestó, y le pide a Claude que las PUNTÚE contra las reglas del persona:
  · human          (0-1) ¿suena a recepcionista humana, no a bot?
  · right_lang      (bool) ¿contestó en el idioma del cliente?
  · toward_booking  (0-1) ¿avanzó hacia la reserva / pasó a recepción cuando tocaba?
  · broke_rules     (lista) qué reglas rompió: dio_hora / confirmo_chica /
                    dio_direccion_sin_pedir / invento_dato / dijo_ia / corrigio_cliente
Da una nota por casa + los peores ejemplos, para pillar regresiones tras tocar el
persona. NO cambia nada; NO manda mensajes.

Corre DESDE /app (importa el paquete app) con el código desplegado:

    docker compose cp scripts/sara_quality_report.py kpi-app:/app/_quality.py
    docker compose exec -u root -T kpi-app python /app/_quality.py         # 20/casa, 7 días
    docker compose exec -u root -T kpi-app python /app/_quality.py 40 30   # 40/casa, 30 días
"""
from __future__ import annotations

import asyncio
import os
import sys

import asyncpg

from app.analyzer import skills

_JUDGE_SYSTEM = (
    "Eres un AUDITOR de calidad de 'Sara', la recepcionista IA de WhatsApp de una "
    "agencia de acompañantes en España. Evalúas UNA respuesta suya al mensaje de un "
    "cliente. Reglas que Sara DEBE cumplir:\n"
    "- Sonar HUMANA y natural (WhatsApp), no robótica ni con guion largo (—).\n"
    "- Contestar en el MISMO idioma que el cliente.\n"
    "- NO preguntar la hora ('¿a qué hora vienes?') ni fijar la hora — eso lo cierra "
    "recepción.\n"
    "- Ante una chica concreta: NO confirmar/describir; mandar la web o, si el cliente "
    "va decidido, pasar a recepción.\n"
    "- NO dar la dirección salvo que la pidan; NO inventar precios/datos.\n"
    "- NO decir que es IA; NO corregir al cliente si la toma por una chica.\n"
    "- Al cerrar/salida: pasar a recepción.\n\n"
    "Puntúa objetivamente. broke_rules = SOLO las reglas realmente rotas (lista vacía "
    "si cumple). Códigos válidos: dio_hora, confirmo_chica, dio_direccion_sin_pedir, "
    "invento_dato, dijo_ia, corrigio_cliente. note = una frase corta del porqué."
)

_JUDGE_SCHEMA = {
    "type": "object",
    "properties": {
        "human": {"type": "number"},
        "right_lang": {"type": "boolean"},
        "toward_booking": {"type": "number"},
        "broke_rules": {"type": "array", "items": {"type": "string"}},
        "note": {"type": "string"},
    },
    "required": ["human", "right_lang", "toward_booking", "broke_rules", "note"],
}

_VALID_RULES = {
    "dio_hora", "confirmo_chica", "dio_direccion_sin_pedir",
    "invento_dato", "dijo_ia", "corrigio_cliente",
}


def _dsn() -> str | None:
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        return None
    scheme, sep, rest = dsn.partition("://")
    return f"{scheme.split('+', 1)[0]}{sep}{rest}" if sep else dsn


async def _judge(client_msg: str, reply: str) -> dict | None:
    user = f"CLIENTE: {client_msg or '(sin texto previo)'}\nSARA: {reply}"
    try:
        return await skills._call_json(_JUDGE_SYSTEM, user, _JUDGE_SCHEMA, max_tokens=300)
    except Exception as exc:  # noqa: BLE001 — un fallo de juez no debe tumbar el informe
        print(f"    (juez falló: {exc})", file=sys.stderr)
        return None


async def _audit_casa(conn: asyncpg.Connection, casa_id: int, name: str,
                      per_casa: int, days: int) -> None:
    rows = await conn.fetch(
        """
        SELECT m.body AS reply, m.created_at,
               (SELECT pm.body FROM message pm
                WHERE pm.conversation_id = m.conversation_id AND pm.direction = 'in'
                  AND pm.body IS NOT NULL AND pm.body <> ''
                  AND pm.created_at < m.created_at
                ORDER BY pm.created_at DESC LIMIT 1) AS client_msg
        FROM message m
        JOIN conversation c ON c.id = m.conversation_id
        WHERE c.casa_id = $1 AND m.direction = 'out' AND m.agent_generated = TRUE
          AND m.body IS NOT NULL AND length(trim(m.body)) > 0
          AND m.created_at >= now() - make_interval(days => $2)
        ORDER BY m.created_at DESC LIMIT $3
        """,
        casa_id, days, per_casa,
    )
    print(f"\n{'─' * 72}\n### CASA {casa_id} — {name}   (evaluando {len(rows)} respuestas)")
    if not rows:
        print("  (Sara no contestó nada en la ventana)")
        return

    human_sum = 0.0
    book_sum = 0.0
    lang_ok = 0
    n = 0
    rule_counts: dict[str, int] = {}
    worst: list[tuple[float, str, str, list[str], str]] = []
    for r in rows:
        v = await _judge(r["client_msg"] or "", r["reply"])
        if v is None:
            continue
        n += 1
        human = float(v.get("human") or 0)
        human_sum += human
        book_sum += float(v.get("toward_booking") or 0)
        if v.get("right_lang"):
            lang_ok += 1
        broke = [x for x in (v.get("broke_rules") or []) if x in _VALID_RULES]
        for rule in broke:
            rule_counts[rule] = rule_counts.get(rule, 0) + 1
        worst.append((human, r["client_msg"] or "", r["reply"], broke, v.get("note") or ""))

    if n == 0:
        print("  (no se pudo evaluar ninguna — ¿juez sin API key?)")
        return
    print(f"  Humano (0-1):        {human_sum / n:.2f}")
    print(f"  Avanza a reserva:    {book_sum / n:.2f}")
    print(f"  Idioma correcto:     {lang_ok}/{n} ({100 * lang_ok // n}%)")
    if rule_counts:
        broke_str = "  ".join(f"{k}={v}" for k, v in sorted(rule_counts.items(), key=lambda kv: -kv[1]))
        print(f"  Reglas rotas:        {broke_str}")
    else:
        print("  Reglas rotas:        ninguna 🎉")
    # 3 peores (menor 'human' o con reglas rotas) para revisar a ojo.
    worst.sort(key=lambda t: (t[0], -len(t[3])))
    print("  Peores ejemplos:")
    for human, cli, rep, broke, note in worst[:3]:
        tag = f" [rompe: {','.join(broke)}]" if broke else ""
        print(f"    · human={human:.2f}{tag}")
        print(f"        C: {(cli or '')[:80]}")
        print(f"        S: {rep[:100]}")
        if note:
            print(f"        juez: {note[:90]}")


async def main() -> int:
    args = [a for a in sys.argv[1:] if a.isdigit()]
    per_casa = int(args[0]) if len(args) >= 1 else 20
    days = int(args[1]) if len(args) >= 2 else 7
    dsn = _dsn()
    if not dsn:
        print("ERROR: DATABASE_URL not set")
        return 2
    print("=" * 72)
    print(f"  SONDA DE CALIDAD DE SARA — {per_casa}/casa, últimos {days} días")
    print(f"  Juez: {skills.MODEL}")
    print("=" * 72)
    pool = await asyncpg.create_pool(dsn, min_size=1, max_size=2)
    try:
        casas = await conn_list_casas(pool)
        for cid, name in casas:
            try:
                async with pool.acquire() as conn:
                    await _audit_casa(conn, cid, name, per_casa, days)
            except Exception as exc:  # noqa: BLE001
                print(f"  casa {cid}: ERROR {exc}")
    finally:
        await pool.close()
    print("\n" + "=" * 72)
    return 0


async def conn_list_casas(pool: asyncpg.Pool) -> list[tuple[int, str]]:
    async with pool.acquire() as conn:
        rows = await conn.fetch("SELECT id, name FROM casa ORDER BY id")
    return [(r["id"], r["name"]) for r in rows]


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
