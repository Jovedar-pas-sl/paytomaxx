#!/usr/bin/env python3
"""Informe SOLO-LECTURA de las conversaciones que CONTESTÓ Sara (el bot) en los
últimos N días — pensado para enviárselo al jefe.

Saca cada conversación donde hay al menos 1 respuesta automática de Sara
(message.direction='out' AND agent_generated=TRUE) dentro de la ventana, y
renderiza el hilo completo (cliente + Sara + equipo) como un HTML autocontenido,
estilo chat, agrupado por casa, con un resumen arriba. Se abre en el navegador,
se imprime a PDF o se reenvía tal cual.

Solo hace SELECTs. NO modifica la app ni la base de datos.

Ejecutar dentro del contenedor kpi-app (donde DATABASE_URL está en el env):

    docker compose cp scripts/dump_bot_conversations.py kpi-app:/tmp/dump_bot.py
    docker compose exec -u root -T kpi-app python /tmp/dump_bot.py            # 7 días, todas las casas
    docker compose exec -u root -T kpi-app python /tmp/dump_bot.py 14         # últimos 14 días
    docker compose exec -u root -T kpi-app python /tmp/dump_bot.py 7 7        # 7 días, solo casa_id=7
    docker compose exec -u root -T -e MASK=1 kpi-app python /tmp/dump_bot.py  # ocultar parte del teléfono

Luego copia el HTML fuera del contenedor:

    docker compose cp kpi-app:/tmp/sara_conversaciones.html ./sara_conversaciones.html
"""
from __future__ import annotations

import asyncio
import html
import os
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

import asyncpg

_TZ = ZoneInfo("Europe/Madrid")
_OUT_PATH = "/tmp/sara_conversaciones.html"
_MAX_CONVS = int(os.environ.get("MAX_CONVS", "5000"))  # tope de seguridad


def _dsn() -> str | None:
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        return None
    scheme, sep, rest = dsn.partition("://")
    return f"{scheme.split('+', 1)[0]}{sep}{rest}" if sep else dsn


def _fmt_dt(dt: datetime) -> str:
    return dt.astimezone(_TZ).strftime("%d/%m %H:%M")


def _fmt_date(dt: datetime) -> str:
    return dt.astimezone(_TZ).strftime("%d/%m/%Y")


def _mask_phone(phone: str) -> str:
    if os.environ.get("MASK") not in ("1", "true", "yes"):
        return phone
    digits = "".join(c for c in phone if c.isdigit())
    if len(digits) < 5:
        return phone
    return f"{digits[:4]}·····{digits[-3:]}"


def _contact_label(name: str | None, phone: str | None, jid: str | None) -> str:
    if name and name.strip():
        return name.strip()
    if phone and phone.strip():
        return _mask_phone(phone.strip())
    if jid and "@" in jid:
        head = jid.split("@", 1)[0]
        return _mask_phone(head) if head.isdigit() else "Contacto (privado)"
    return "Contacto"


_MEDIA_LABEL = {
    "image": "📷 Foto",
    "video": "🎬 Vídeo",
    "audio": "🎙️ Nota de voz",
    "application": "📎 Documento",
}


def _media_tag(mime: str | None) -> str | None:
    if not mime:
        return None
    return _MEDIA_LABEL.get(mime.split("/", 1)[0], "📎 Adjunto")


# ── HTML ──────────────────────────────────────────────────────────────
_CSS = """
* { box-sizing: border-box; }
body { margin:0; background:#eceff1; color:#0f1a14;
  font-family:-apple-system,'Segoe UI',Roboto,system-ui,sans-serif; line-height:1.5; }
.wrap { max-width:900px; margin:0 auto; padding:24px 16px 64px; }
header.top { background:linear-gradient(135deg,#0e4735,#17624a); color:#eef7f2;
  border-radius:14px; padding:26px 28px; box-shadow:0 8px 30px -14px rgba(14,71,53,.5); }
header.top h1 { margin:0 0 6px; font-size:1.7rem; letter-spacing:-.01em; }
header.top .sub { opacity:.85; font-size:.95rem; }
.stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin:18px 0 8px; }
.stat { background:#fff; border:1px solid #dbe4e0; border-radius:12px; padding:14px 16px; }
.stat .n { font-size:1.8rem; font-weight:700; color:#17624a; font-variant-numeric:tabular-nums; }
.stat .l { font-size:.8rem; color:#5c6b64; text-transform:uppercase; letter-spacing:.06em; }
table.byhouse { width:100%; border-collapse:collapse; background:#fff; border-radius:12px;
  overflow:hidden; border:1px solid #dbe4e0; margin-top:8px; font-size:.92rem; }
table.byhouse th,table.byhouse td { padding:10px 14px; text-align:left; border-bottom:1px solid #eef2f0; }
table.byhouse th { background:#f4f7f5; font-size:.72rem; text-transform:uppercase; letter-spacing:.06em; color:#5c6b64; }
table.byhouse td.num { text-align:right; font-variant-numeric:tabular-nums; }
.legend { display:flex; gap:16px; flex-wrap:wrap; margin:22px 0 6px; font-size:.82rem; color:#5c6b64; }
.legend span { display:inline-flex; align-items:center; gap:6px; }
.dot { width:12px; height:12px; border-radius:4px; display:inline-block; }
h2.casa { margin:34px 0 4px; font-size:1.25rem; color:#0e4735; border-bottom:2px solid #17624a; padding-bottom:6px; }
.conv { background:#fff; border:1px solid #dbe4e0; border-radius:14px; margin:16px 0; overflow:hidden;
  box-shadow:0 2px 10px -6px rgba(15,26,20,.18); page-break-inside:avoid; }
.conv-h { background:#f4f7f5; padding:12px 16px; display:flex; justify-content:space-between;
  align-items:center; gap:12px; border-bottom:1px solid #e6ece9; flex-wrap:wrap; }
.conv-h .who { font-weight:650; }
.conv-h .meta { font-size:.8rem; color:#6a7871; font-variant-numeric:tabular-nums; }
.badge { background:#17624a; color:#fff; font-size:.72rem; padding:2px 9px; border-radius:20px; white-space:nowrap; }
.thread { padding:14px 16px; background:#e7efe9; display:flex; flex-direction:column; gap:8px; }
.row { display:flex; }
.row.out { justify-content:flex-end; }
.bubble { max-width:78%; padding:8px 12px; border-radius:14px; font-size:.94rem; position:relative;
  box-shadow:0 1px 1px rgba(0,0,0,.06); word-wrap:break-word; }
.row.in .bubble { background:#fff; border-top-left-radius:4px; }
.row.out.bot .bubble { background:#d7f5c8; border-top-right-radius:4px; }
.row.out.human .bubble { background:#cfe6ff; border-top-right-radius:4px; }
.who-tag { font-size:.68rem; font-weight:700; letter-spacing:.02em; margin-bottom:2px; }
.in .who-tag { color:#6a7871; }
.bot .who-tag { color:#166b3a; }
.human .who-tag { color:#1256a0; }
.time { font-size:.66rem; color:#8794; margin-top:3px; text-align:right; }
.media { font-style:italic; color:#4a5a52; }
.empty { background:#fff; border-radius:12px; padding:26px; text-align:center; color:#6a7871; }
footer.foot { margin-top:32px; font-size:.78rem; color:#8593; text-align:center; }
@media print { body { background:#fff; } .conv,.stat,table.byhouse { box-shadow:none; } .wrap { max-width:100%; } }
"""


def _bubble(direction: str, agent: bool, body: str | None, mime: str | None,
            when: datetime, contact: str) -> str:
    if direction == "in":
        cls, tag = "in", html.escape(contact)
    elif agent:
        cls, tag = "out bot", "Sara 🤖"
    else:
        cls, tag = "out human", "Equipo"
    parts: list[str] = []
    media = _media_tag(mime)
    if media:
        parts.append(f'<span class="media">{html.escape(media)}</span>')
    text = (body or "").strip()
    if text:
        parts.append(html.escape(text).replace("\n", "<br>"))
    if not parts:
        parts.append('<span class="media">[mensaje vacío]</span>')
    content = "<br>".join(parts)
    return (
        f'<div class="row {cls}"><div class="bubble">'
        f'<div class="who-tag">{tag}</div>{content}'
        f'<div class="time">{_fmt_dt(when)}</div></div></div>'
    )


async def main() -> int:
    args = [a for a in sys.argv[1:] if a.isdigit()]
    days = int(args[0]) if len(args) >= 1 else 7
    only_casa = int(args[1]) if len(args) >= 2 else None

    dsn = _dsn()
    if not dsn:
        print("ERROR: DATABASE_URL not set", file=sys.stderr)
        return 2

    pool = await asyncpg.create_pool(dsn, min_size=1, max_size=2)
    try:
        async with pool.acquire() as c:
            casa_clause = "AND co.casa_id = $2" if only_casa is not None else ""
            params: list = [days] + ([only_casa] if only_casa is not None else [])
            convs = await c.fetch(
                f"""
                SELECT co.id AS conv_id, co.casa_id, ca.name AS casa_name,
                       ct.name AS c_name, ct.phone AS c_phone, ct.waha_jid AS c_jid,
                       COUNT(*) FILTER (WHERE m.direction='out' AND m.agent_generated) AS bot_msgs,
                       MAX(m.created_at) AS last_at
                FROM conversation co
                JOIN casa ca ON ca.id = co.casa_id
                LEFT JOIN contact ct ON ct.id = co.contact_id
                JOIN message m ON m.conversation_id = co.id
                    AND m.created_at >= now() - make_interval(days => $1)
                WHERE co.id IN (
                    SELECT DISTINCT conversation_id FROM message
                    WHERE direction='out' AND agent_generated = TRUE
                      AND created_at >= now() - make_interval(days => $1)
                ) {casa_clause}
                GROUP BY co.id, co.casa_id, ca.name, ct.name, ct.phone, ct.waha_jid
                ORDER BY ca.name, last_at DESC
                LIMIT {_MAX_CONVS}
                """,
                *params,
            )

            conv_ids = [r["conv_id"] for r in convs]
            msgs_by_conv: dict[int, list[asyncpg.Record]] = {cid: [] for cid in conv_ids}
            if conv_ids:
                msgs = await c.fetch(
                    """
                    SELECT conversation_id, direction, body, media_mime,
                           agent_generated, created_at
                    FROM message
                    WHERE conversation_id = ANY($1::bigint[])
                      AND created_at >= now() - make_interval(days => $2)
                    ORDER BY conversation_id, created_at ASC
                    """,
                    conv_ids, days,
                )
                for m in msgs:
                    msgs_by_conv[m["conversation_id"]].append(m)

        # ── aggregates ──
        total_convs = len(convs)
        total_bot = sum(r["bot_msgs"] for r in convs)
        by_house: dict[str, dict[str, int]] = {}
        for r in convs:
            h = by_house.setdefault(r["casa_name"], {"convs": 0, "bot": 0})
            h["convs"] += 1
            h["bot"] += r["bot_msgs"]

        now = datetime.now(_TZ)
        since = f"{days} días"
        gen = now.strftime("%d/%m/%Y %H:%M")

        # ── build HTML ──
        out: list[str] = []
        out.append("<!doctype html><html lang='es'><head><meta charset='utf-8'>")
        out.append("<meta name='viewport' content='width=device-width,initial-scale=1'>")
        out.append("<title>Conversaciones de Sara</title>")
        out.append(f"<style>{_CSS}</style></head><body><div class='wrap'>")
        out.append("<header class='top'>")
        out.append("<h1>Conversaciones contestadas por Sara</h1>")
        out.append(f"<div class='sub'>Últimos {since} · generado el {gen}</div>")
        out.append("</header>")

        out.append("<div class='stats'>")
        out.append(f"<div class='stat'><div class='n'>{total_convs}</div>"
                   "<div class='l'>Conversaciones</div></div>")
        out.append(f"<div class='stat'><div class='n'>{total_bot}</div>"
                   "<div class='l'>Respuestas de Sara</div></div>")
        out.append(f"<div class='stat'><div class='n'>{len(by_house)}</div>"
                   "<div class='l'>Casas</div></div>")
        out.append("</div>")

        if by_house:
            out.append("<table class='byhouse'><thead><tr><th>Casa</th>"
                       "<th class='num'>Conversaciones</th>"
                       "<th class='num'>Respuestas de Sara</th></tr></thead><tbody>")
            for hname, hv in sorted(by_house.items()):
                out.append(f"<tr><td>{html.escape(hname)}</td>"
                           f"<td class='num'>{hv['convs']}</td>"
                           f"<td class='num'>{hv['bot']}</td></tr>")
            out.append("</tbody></table>")

        out.append("<div class='legend'>"
                   "<span><span class='dot' style='background:#fff;border:1px solid #cdd6d1'></span> Cliente</span>"
                   "<span><span class='dot' style='background:#d7f5c8'></span> Sara (bot)</span>"
                   "<span><span class='dot' style='background:#cfe6ff'></span> Equipo (humano)</span></div>")

        if not convs:
            out.append("<div class='empty'>Sara no contestó ninguna conversación "
                       f"en los últimos {since}.</div>")

        current_house = None
        for r in convs:
            if r["casa_name"] != current_house:
                current_house = r["casa_name"]
                out.append(f"<h2 class='casa'>{html.escape(current_house)}</h2>")
            contact = _contact_label(r["c_name"], r["c_phone"], r["c_jid"])
            thread = msgs_by_conv.get(r["conv_id"], [])
            when_range = _fmt_date(r["last_at"]) if r["last_at"] else ""
            out.append("<div class='conv'><div class='conv-h'>")
            out.append(f"<span class='who'>{html.escape(contact)}</span>")
            out.append(f"<span class='meta'>{when_range} · "
                       f"<span class='badge'>{r['bot_msgs']} de Sara</span></span>")
            out.append("</div><div class='thread'>")
            for m in thread:
                out.append(_bubble(m["direction"], m["agent_generated"], m["body"],
                                   m["media_mime"], m["created_at"], contact))
            out.append("</div></div>")

        out.append("<footer class='foot'>Informe generado automáticamente · "
                   "solo conversaciones con al menos una respuesta de Sara · "
                   f"ventana: últimos {since}.</footer>")
        out.append("</div></body></html>")

        with open(_OUT_PATH, "w", encoding="utf-8") as f:
            f.write("".join(out))

        # resumen a stdout
        print("=" * 60)
        print(f"  Conversaciones contestadas por Sara — últimos {since}")
        print("=" * 60)
        print(f"  Conversaciones : {total_convs}")
        print(f"  Respuestas Sara: {total_bot}")
        print(f"  Casas          : {len(by_house)}")
        for hname, hv in sorted(by_house.items()):
            print(f"    · {hname:<28} {hv['convs']:>4} conv / {hv['bot']:>4} de Sara")
        print("-" * 60)
        print(f"  HTML escrito en: {_OUT_PATH}")
        print("  Cópialo fuera con:")
        print(f"    docker compose cp kpi-app:{_OUT_PATH} ./sara_conversaciones.html")
        print("=" * 60)
    finally:
        await pool.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
