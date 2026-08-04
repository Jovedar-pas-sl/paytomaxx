"""Export endpoints: CSV for lists, Markdown for IA reports, TXT for transcripts,
printable HTML + DOCX for per-conversation analysis reports.

All endpoints are behind CurrentUser auth. UTF-8 BOM added to CSVs so Excel
detects the encoding correctly for ñ/emojis.
"""

from __future__ import annotations

import csv
import html
import io
import json as _json
from datetime import date, datetime, timezone
from urllib.parse import quote
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import HTMLResponse, Response, StreamingResponse
from app import queries
from app.deps import CurrentUser, KpiDB
from app.template_env import templates

router = APIRouter()
UTF8_BOM = "﻿"


def _safe_filename(name: str) -> str:
    import unicodedata
    normalized = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return "".join(c if c.isalnum() or c in "-_" else "-" for c in normalized).strip("-") or "file"


def _download_response(body: str, filename: str, media_type: str) -> StreamingResponse:
    safe = _safe_filename(filename)
    return StreamingResponse(
        iter([body]),
        media_type=media_type,
        headers={
            "Content-Disposition": f"attachment; filename=\"{safe}\"; filename*=UTF-8''{quote(filename)}",
            "Cache-Control": "no-store",
        },
    )


async def _get_casa_name(kpi, casa_id: int) -> str:
    async with kpi.acquire() as conn:
        row = await conn.fetchrow("SELECT name FROM casa WHERE id = $1", casa_id)
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Casa no encontrada")
    return row["name"]


# ── Export conversations list (CSV) ────────────────────────────────
@router.get("/casas/{casa_id}/export/conversations.csv")
async def export_conversations_csv(
    casa_id: int,
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
) -> StreamingResponse:
    casa_name = await _get_casa_name(kpi, casa_id)

    # with_counts=True: the CSV is the only consumer of message_count.
    rows, _ = await queries.list_conversations(
        kpi, casa_id=casa_id, limit=1000, offset=0, with_counts=True
    )

    conv_ids = [r.id for r in rows]
    analysis_map: dict[int, dict] = {}
    if conv_ids:
        async with kpi.acquire() as conn:
            a_rows = await conn.fetch(
                """
                SELECT conversation_id, mood_label, mood_score, conv_probability,
                       treat_carinoso, treat_profesional, treat_vendedor, treat_seco,
                       rt_p50, rt_p90, red_flags
                FROM analysis WHERE conversation_id = ANY($1)
                """,
                conv_ids,
            )
        analysis_map = {r["conversation_id"]: r for r in a_rows}

    buf = io.StringIO()
    buf.write(UTF8_BOM)
    w = csv.writer(buf, lineterminator="\n")
    w.writerow([
        "conv_id", "contact", "telefono", "casa", "estado", "mensajes",
        "ultimo_msg", "analizado",
        "mood", "mood_score", "conversion_pct",
        "carinoso", "profesional", "vendedor", "seco",
        "resp_p50_seg", "resp_p90_min", "red_flags_count",
    ])
    for r in rows:
        a = analysis_map.get(r.id)
        red_flags_count = 0
        if a and a["red_flags"]:
            try:
                import json as _json
                rf = _json.loads(a["red_flags"]) if isinstance(a["red_flags"], str) else a["red_flags"]
                red_flags_count = len(rf or [])
            except Exception:
                red_flags_count = 0

        w.writerow([
            r.id,
            r.contact_name or "",
            r.contact_phone or "",
            r.account_name or "",
            r.status,
            r.message_count,
            r.last_message_at.isoformat(),
            "si" if a else "no",
            a["mood_label"] if a else "",
            a["mood_score"] if a else "",
            int((float(a["conv_probability"])) * 100) if a else "",
            a["treat_carinoso"] if a else "",
            a["treat_profesional"] if a else "",
            a["treat_vendedor"] if a else "",
            a["treat_seco"] if a else "",
            (a["rt_p50"] // 1000) if a else "",
            (a["rt_p90"] // 60000) if a else "",
            red_flags_count,
        ])

    fname = f"{casa_name}-conversaciones-{date.today().isoformat()}.csv"
    return _download_response(buf.getvalue(), fname, "text/csv; charset=utf-8")


# ── Export FULL conversations (printable HTML → PDF) ───────────────
# Unlike the CSV above (a LIST), this renders the complete threads (client +
# Sara + team) of every conversation matching the CURRENT inbox filters, so the
# admin can open it in a new tab and Ctrl+P → Save as PDF. Read-only; reuses the
# exact same filtered query the inbox uses (list_conversations_page).

_TZ = ZoneInfo("Europe/Madrid")
_PERIOD_DAYS = {"24h": 1, "7d": 7, "30d": 30, "90d": 90, "all": 3650}
_PERIOD_LABEL = {"24h": "últimas 24h", "7d": "últimos 7 días",
                 "30d": "últimos 30 días", "90d": "últimos 90 días", "all": "histórico"}
_MODE_LABEL = {"auto": "Modo Auto", "copilot": "Modo Copiloto", "off": "Modo Off"}
_EXPORT_MAX_CONVS = 600
_MEDIA_LABEL = {"image": "📷 Foto", "video": "🎬 Vídeo",
                "audio": "🎙️ Nota de voz", "application": "📎 Documento"}

_EXPORT_CSS = """
*{box-sizing:border-box}body{margin:0;background:#eceff1;color:#0f1a14;
font-family:-apple-system,'Segoe UI',Roboto,system-ui,sans-serif;line-height:1.5}
.wrap{max-width:900px;margin:0 auto;padding:24px 16px 64px}
header.top{background:linear-gradient(135deg,#0e4735,#17624a);color:#eef7f2;border-radius:14px;
padding:24px 26px;box-shadow:0 8px 30px -14px rgba(14,71,53,.5)}
header.top h1{margin:0 0 6px;font-size:1.6rem}header.top .sub{opacity:.85;font-size:.92rem}
.stats{display:flex;gap:12px;flex-wrap:wrap;margin:18px 0 6px}
.stat{background:#fff;border:1px solid #dbe4e0;border-radius:12px;padding:12px 16px;min-width:140px}
.stat .n{font-size:1.6rem;font-weight:700;color:#17624a;font-variant-numeric:tabular-nums}
.stat .l{font-size:.76rem;color:#5c6b64;text-transform:uppercase;letter-spacing:.06em}
.legend{display:flex;gap:16px;flex-wrap:wrap;margin:16px 0;font-size:.82rem;color:#5c6b64}
.legend span{display:inline-flex;align-items:center;gap:6px}
.dot{width:12px;height:12px;border-radius:4px;display:inline-block}
.conv{background:#fff;border:1px solid #dbe4e0;border-radius:14px;margin:16px 0;overflow:hidden;
box-shadow:0 2px 10px -6px rgba(15,26,20,.18);page-break-inside:avoid}
.conv-h{background:#f4f7f5;padding:11px 16px;display:flex;justify-content:space-between;
align-items:center;gap:12px;border-bottom:1px solid #e6ece9;flex-wrap:wrap}
.conv-h .who{font-weight:650}.conv-h .meta{font-size:.8rem;color:#6a7871}
.badge{background:#17624a;color:#fff;font-size:.72rem;padding:2px 9px;border-radius:20px;white-space:nowrap}
.thread{padding:14px 16px;background:#e7efe9;display:flex;flex-direction:column;gap:8px}
.row{display:flex}.row.out{justify-content:flex-end}
.bubble{max-width:78%;padding:8px 12px;border-radius:14px;font-size:.94rem;
box-shadow:0 1px 1px rgba(0,0,0,.06);word-wrap:break-word;overflow-wrap:anywhere}
.row.in .bubble{background:#fff;border-top-left-radius:4px}
.row.out.bot .bubble{background:#d7f5c8;border-top-right-radius:4px}
.row.out.human .bubble{background:#cfe6ff;border-top-right-radius:4px}
.who-tag{font-size:.68rem;font-weight:700;margin-bottom:2px}
.in .who-tag{color:#6a7871}.bot .who-tag{color:#166b3a}.human .who-tag{color:#1256a0}
.time{font-size:.66rem;color:#8a9;margin-top:3px;text-align:right}
.media{font-style:italic;color:#4a5a52}
.empty{background:#fff;border-radius:12px;padding:26px;text-align:center;color:#6a7871}
footer.foot{margin-top:30px;font-size:.78rem;color:#8593;text-align:center}
.toolbar{position:sticky;top:0;z-index:10;display:flex;gap:12px;align-items:center;flex-wrap:wrap;
background:#0e4735;color:#eef7f2;padding:12px 16px;border-radius:0 0 12px 12px;margin:-24px -16px 18px}
.toolbar button{background:#d7f5c8;color:#0e4735;border:0;border-radius:9px;padding:9px 16px;
font-size:.95rem;font-weight:700;cursor:pointer}
.toolbar button:hover{background:#c3ecac}
.toolbar .hint{font-size:.82rem;opacity:.9}
@media print{body{background:#fff}.conv,.stat{box-shadow:none}.wrap{max-width:100%}
.no-print{display:none!important}}
"""


def _export_bubble(m, contact_label: str) -> str:
    if m.direction == "in":
        cls, tag = "in", html.escape(contact_label)
    elif m.agent_generated:
        cls, tag = "out bot", "Sara 🤖"
    else:
        cls, tag = "out human", "Equipo"
    parts: list[str] = []
    if m.media_mime:
        label = _MEDIA_LABEL.get(m.media_mime.split("/", 1)[0], "📎 Adjunto")
        parts.append(f'<span class="media">{html.escape(label)}</span>')
    text = (m.body or "").strip()
    if text:
        parts.append(html.escape(text).replace("\n", "<br>"))
    if not parts:
        parts.append('<span class="media">[mensaje]</span>')
    ts = m.created_at.astimezone(_TZ).strftime("%d/%m %H:%M")
    return (f'<div class="row {cls}"><div class="bubble"><div class="who-tag">{tag}</div>'
            f'{"<br>".join(parts)}<div class="time">{ts}</div></div></div>')


def _render_conversations_html(casa_name: str, period: str, mode: str,
                               conv_rows: list, threads: dict, truncated: bool) -> str:
    period_txt = _PERIOD_LABEL.get(period, period)
    mode_txt = _MODE_LABEL.get(mode or "", "todos los modos")
    total_bot = sum(1 for r in conv_rows for m in threads.get(r.id, [])
                    if m.direction == "out" and getattr(m, "agent_generated", False))
    gen = datetime.now(_TZ).strftime("%d/%m/%Y %H:%M")

    out: list[str] = [
        "<!doctype html><html lang='es'><head><meta charset='utf-8'>",
        "<meta name='viewport' content='width=device-width,initial-scale=1'>",
        f"<title>Conversaciones — {html.escape(casa_name)}</title>",
        f"<style>{_EXPORT_CSS}</style></head><body><div class='wrap'>",
        "<div class='toolbar no-print'>"
        "<button onclick='window.print()'>⬇️ Guardar como PDF</button>"
        "<span class='hint'>Se abre la ventana de imprimir sola → en <b>Destino</b> elige "
        "<b>Guardar como PDF</b> → <b>Guardar</b>.</span>"
        "</div>",
        "<header class='top'><h1>Conversaciones de WhatsApp</h1>",
        f"<div class='sub'>{html.escape(casa_name)} · {period_txt} · {mode_txt} · "
        f"generado el {gen}</div></header>",
        "<div class='stats'>",
        f"<div class='stat'><div class='n'>{len(conv_rows)}</div>"
        "<div class='l'>Conversaciones</div></div>",
        f"<div class='stat'><div class='n'>{total_bot}</div>"
        "<div class='l'>Respuestas de Sara</div></div>",
        "</div>",
        "<div class='legend'>"
        "<span><span class='dot' style='background:#fff;border:1px solid #cdd6d1'></span> Cliente</span>"
        "<span><span class='dot' style='background:#d7f5c8'></span> Sara (bot)</span>"
        "<span><span class='dot' style='background:#cfe6ff'></span> Equipo (humano)</span></div>",
    ]
    if truncated:
        out.append(f"<div class='sub' style='color:#9c4526'>Mostrando las primeras "
                   f"{_EXPORT_MAX_CONVS} conversaciones (hay más; afina el filtro para verlas todas).</div>")
    if not conv_rows:
        out.append("<div class='empty'>No hay conversaciones con este filtro.</div>")

    for r in conv_rows:
        contact = r.contact_name or r.contact_phone or "Contacto"
        when = r.last_message_at.astimezone(_TZ).strftime("%d/%m/%Y") if r.last_message_at else ""
        msgs = threads.get(r.id, [])
        bot_n = sum(1 for m in msgs if m.direction == "out" and getattr(m, "agent_generated", False))
        out.append("<div class='conv'><div class='conv-h'>")
        out.append(f"<span class='who'>{html.escape(contact)}</span>")
        out.append(f"<span class='meta'>{when} · <span class='badge'>{bot_n} de Sara</span></span>")
        out.append("</div><div class='thread'>")
        for m in msgs:
            out.append(_export_bubble(m, contact))
        out.append("</div></div>")

    out.append(f"<footer class='foot'>{html.escape(casa_name)} · {period_txt} · {mode_txt} · "
               "solo conversaciones que coinciden con el filtro del panel.</footer>")
    # Auto-open the browser's print dialog so the user just picks "Guardar como PDF".
    out.append("<script>window.addEventListener('load',function(){"
               "setTimeout(function(){try{window.print();}catch(e){}},500);});</script>")
    out.append("</div></body></html>")
    return "".join(out)


async def _collect_filtered_threads(
    kpi, casa_id: int, wa: str, period: str, unanswered: bool, search: str,
    mood: str, status: str, handler: str, mode: str,
):
    """Shared by the HTML + DOCX conversation exports: parse the inbox filters,
    page through ALL matching conversations (keyset, capped at _EXPORT_MAX_CONVS),
    and fetch each full thread. Returns (casa_name, mode_q, conv_rows, threads,
    truncated). Read-only."""
    casa_name = await _get_casa_name(kpi, casa_id)

    wa_number_id: int | None = None
    if wa != "all":
        try:
            wa_number_id = int(wa)
        except ValueError:
            wa_number_id = None
    days = _PERIOD_DAYS.get(period, 3650)
    since_days = None if days >= 3650 else days
    search_q = (search or "").strip() or None
    mood_q = mood if mood in {"curioso", "decidido", "calenton", "indeciso", "enfadado", "timewaster"} else None
    status_q = status if status in {"open", "resolved", "pending"} else None
    handler_q = handler if handler in {"bot", "human"} else None
    mode_q = mode if mode in {"auto", "copilot", "off"} else None

    conv_rows: list = []
    cur_ts: datetime | None = None
    cur_id: int | None = None
    truncated = False
    while True:
        page, next_ts, next_id = await queries.list_conversations_page(
            kpi, casa_id=casa_id, wa_number_id=wa_number_id, since_days=since_days,
            unanswered_only=unanswered, handler=handler_q, mode=mode_q,
            search=search_q, mood=mood_q, status=status_q,
            limit=100, cursor_ts=cur_ts, cursor_id=cur_id,
        )
        conv_rows.extend(page)
        if len(conv_rows) >= _EXPORT_MAX_CONVS:
            conv_rows = conv_rows[:_EXPORT_MAX_CONVS]
            truncated = bool(next_ts)
            break
        if not next_ts:
            break
        cur_ts, cur_id = next_ts, next_id

    threads: dict[int, list] = {}
    for r in conv_rows:
        threads[r.id] = await queries.list_messages_for_conversation(kpi, r.id)
    return casa_name, mode_q, conv_rows, threads, truncated


def _msg_speaker_text(m, contact_label: str) -> tuple[str, str]:
    """(speaker_label, text) for a message — for the plain DOCX rendering."""
    if m.direction == "in":
        speaker = contact_label
    elif getattr(m, "agent_generated", False):
        speaker = "Sara"
    else:
        speaker = "Equipo"
    text = (m.body or "").strip()
    if not text and m.media_mime:
        text = _MEDIA_LABEL.get(m.media_mime.split("/", 1)[0], "📎 Adjunto")
    return speaker, (text or "[mensaje]")


@router.get("/casas/{casa_id}/export/conversaciones", response_class=HTMLResponse)
async def export_conversations_full(
    casa_id: int,
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
    wa: str = "all",
    period: str = "all",
    unanswered: bool = False,
    search: str = "",
    mood: str = "",
    status: str = "",
    handler: str = "",
    mode: str = "",
) -> HTMLResponse:
    """Printable page with the FULL threads of every conversation matching the
    current inbox filters. Open in a new tab → Ctrl+P → Save as PDF. Read-only."""
    casa_name, mode_q, conv_rows, threads, truncated = await _collect_filtered_threads(
        kpi, casa_id, wa, period, unanswered, search, mood, status, handler, mode)
    body = _render_conversations_html(casa_name, period, mode_q or "", conv_rows, threads, truncated)
    return HTMLResponse(body)


@router.get("/casas/{casa_id}/export/conversaciones.docx")
async def export_conversations_full_docx(
    casa_id: int,
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
    wa: str = "all",
    period: str = "all",
    unanswered: bool = False,
    search: str = "",
    mood: str = "",
    status: str = "",
    handler: str = "",
    mode: str = "",
) -> Response:
    """One-click Word (.docx) download of the SAME filtered full conversations —
    no print dialog needed. Opens in Word; export to PDF there if wanted."""
    try:
        from docx import Document  # type: ignore
    except ImportError as exc:
        raise HTTPException(
            status_code=500,
            detail="python-docx no instalado — rebuild del contenedor necesario",
        ) from exc

    casa_name, mode_q, conv_rows, threads, truncated = await _collect_filtered_threads(
        kpi, casa_id, wa, period, unanswered, search, mood, status, handler, mode)
    period_txt = _PERIOD_LABEL.get(period, period)
    mode_txt = _MODE_LABEL.get(mode_q or "", "todos los modos")
    total_bot = sum(1 for r in conv_rows for m in threads.get(r.id, [])
                    if m.direction == "out" and getattr(m, "agent_generated", False))
    gen = datetime.now(_TZ).strftime("%d/%m/%Y %H:%M")

    doc = Document()
    doc.add_heading(f"Conversaciones de WhatsApp — {casa_name}", level=0)
    doc.add_paragraph(
        f"{period_txt} · {mode_txt} · generado {gen} · "
        f"{len(conv_rows)} conversaciones · {total_bot} respuestas de Sara"
    ).italic = True
    if truncated:
        doc.add_paragraph(f"(Mostrando las primeras {_EXPORT_MAX_CONVS}; "
                          "afina el filtro para ver más.)")
    if not conv_rows:
        doc.add_paragraph("No hay conversaciones con este filtro.")

    for r in conv_rows:
        contact = r.contact_name or r.contact_phone or "Contacto"
        when = r.last_message_at.astimezone(_TZ).strftime("%d/%m/%Y") if r.last_message_at else ""
        msgs = threads.get(r.id, [])
        bot_n = sum(1 for m in msgs if m.direction == "out" and getattr(m, "agent_generated", False))
        doc.add_heading(f"{contact} · {when} · {bot_n} de Sara", level=2)
        for m in msgs:
            speaker, text = _msg_speaker_text(m, contact)
            ts = m.created_at.astimezone(_TZ).strftime("%d/%m %H:%M")
            p = doc.add_paragraph()
            p.add_run(f"[{ts}] {speaker}: ").bold = True
            p.add_run(text)

    buf = io.BytesIO()
    doc.save(buf)
    buf.seek(0)
    fname = f"conversaciones-{casa_name}-{date.today().isoformat()}.docx"
    safe = _safe_filename(fname)
    return Response(
        content=buf.read(),
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={
            "Content-Disposition": f'attachment; filename="{safe}"; filename*=UTF-8\'\'{quote(fname)}',
            "Cache-Control": "no-store",
        },
    )


def _pdf_soft_break(s: str, n: int = 45) -> str:
    """Insert a space inside any unbroken run of >n chars (long URLs) so fpdf2's
    multi_cell never overflows a single token."""
    out: list[str] = []
    run = 0
    for ch in s:
        out.append(ch)
        if ch.isspace():
            run = 0
        else:
            run += 1
            if run >= n:
                out.append(" ")
                run = 0
    return "".join(out)


def _pdf_txt(s: str) -> str:
    """fpdf2 core fonts are Latin-1 only. Map common typographic chars and drop
    anything else (emojis) so the PDF never crashes on real client messages."""
    if not s:
        return ""
    for k, v in (("—", "-"), ("–", "-"), ("…", "..."), ("“", '"'), ("”", '"'),
                 ("‘", "'"), ("’", "'"), ("€", " EUR"), ("•", "-"),
                 ("‍", ""), ("️", "")):
        s = s.replace(k, v)
    return _pdf_soft_break(s.encode("latin-1", "ignore").decode("latin-1"))


def _render_conversations_pdf(casa_name, period, mode, conv_rows, threads, truncated) -> bytes:
    """Draw the conversations as real chat BUBBLES (coloured, left/right aligned)
    so the downloaded PDF keeps the on-screen design without depending on the
    browser print dialog (which strips background colours by default)."""
    from fpdf import FPDF  # type: ignore

    period_txt = _PERIOD_LABEL.get(period, period)
    mode_txt = _MODE_LABEL.get(mode or "", "todos los modos")
    total_bot = sum(1 for r in conv_rows for m in threads.get(r.id, [])
                    if m.direction == "out" and getattr(m, "agent_generated", False))
    gen = datetime.now(_TZ).strftime("%d/%m/%Y %H:%M")

    pdf = FPDF(format="A4")
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.set_title(_pdf_txt(f"Conversaciones {casa_name}"))
    pdf.add_page()
    usable = pdf.w - pdf.l_margin - pdf.r_margin
    inner_max = usable * 0.66  # max bubble width → clearly a chat, not full-width

    def full(h: float, txt: str, size: int, style: str = "", rgb=(0, 0, 0),
             fill_rgb=None) -> None:
        pdf.set_font("Helvetica", style, size)
        pdf.set_text_color(*rgb)
        if fill_rgb:
            pdf.set_fill_color(*fill_rgb)
        pdf.set_x(pdf.l_margin)
        pdf.multi_cell(0, h, _pdf_txt(txt), new_x="LMARGIN", new_y="NEXT",
                       fill=bool(fill_rgb))

    full(9, f"Conversaciones de WhatsApp - {casa_name}", 16, "B")
    full(6, f"{period_txt} - {mode_txt} - generado {gen} - "
            f"{len(conv_rows)} conversaciones - {total_bot} respuestas de Sara", 10, "", (90, 90, 90))
    if truncated:
        full(6, f"(Mostrando las primeras {_EXPORT_MAX_CONVS}; afina el filtro.)", 9, "", (156, 69, 38))
    pdf.ln(2)
    if not conv_rows:
        full(6, "No hay conversaciones con este filtro.", 11)

    for r in conv_rows:
        contact = r.contact_name or r.contact_phone or "Contacto"
        when = r.last_message_at.astimezone(_TZ).strftime("%d/%m/%Y") if r.last_message_at else ""
        msgs = threads.get(r.id, [])
        bot_n = sum(1 for m in msgs if m.direction == "out" and getattr(m, "agent_generated", False))
        pdf.ln(2)
        full(7, f"{contact}   -   {when}   -   {bot_n} de Sara", 11, "B", (14, 71, 53), (224, 238, 231))
        pdf.ln(1)
        for m in msgs:
            speaker, text = _msg_speaker_text(m, contact)
            ts = m.created_at.astimezone(_TZ).strftime("%d/%m %H:%M")
            out_side = m.direction == "out"
            if m.direction == "in":
                bubble, labelc, border = (255, 255, 255), (90, 90, 90), 1
            elif getattr(m, "agent_generated", False):
                bubble, labelc, border = (215, 245, 200), (22, 107, 58), 0
            else:
                bubble, labelc, border = (207, 230, 255), (18, 86, 160), 0
            body = _pdf_txt(text)
            pdf.set_font("Helvetica", "", 9)
            w_est = pdf.get_string_width(body.replace("\n", " "))
            bubble_w = min(inner_max, max(w_est + 6, 24))
            x = (pdf.w - pdf.r_margin - bubble_w) if out_side else pdf.l_margin
            # label (speaker · time) above the bubble, aligned to its side
            pdf.set_font("Helvetica", "B", 7)
            pdf.set_text_color(*labelc)
            pdf.set_x(x)
            pdf.cell(bubble_w, 3.8, _pdf_txt(f"{speaker}  ·  {ts}"),
                     new_x="LMARGIN", new_y="NEXT", align="R" if out_side else "L")
            # bubble body (filled box in the role colour)
            pdf.set_font("Helvetica", "", 9)
            pdf.set_text_color(30, 30, 30)
            pdf.set_fill_color(*bubble)
            pdf.set_draw_color(214, 222, 218)
            pdf.set_x(x)
            pdf.multi_cell(bubble_w, 5, body, border=border, align="L", fill=True,
                           new_x="LMARGIN", new_y="NEXT")
            pdf.ln(1.5)
        pdf.set_text_color(0, 0, 0)

    return bytes(pdf.output())


@router.get("/casas/{casa_id}/export/conversaciones.pdf")
async def export_conversations_full_pdf(
    casa_id: int,
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
    wa: str = "all",
    period: str = "all",
    unanswered: bool = False,
    search: str = "",
    mood: str = "",
    status: str = "",
    handler: str = "",
    mode: str = "",
) -> Response:
    """One-click PDF download of the SAME filtered full conversations — no print
    dialog, downloads straight to the browser like the CSV."""
    try:
        from fpdf import FPDF  # type: ignore  # noqa: F401
    except ImportError as exc:
        raise HTTPException(
            status_code=500,
            detail="fpdf2 no instalado — rebuild del contenedor necesario",
        ) from exc

    casa_name, mode_q, conv_rows, threads, truncated = await _collect_filtered_threads(
        kpi, casa_id, wa, period, unanswered, search, mood, status, handler, mode)
    pdf_bytes = _render_conversations_pdf(casa_name, period, mode_q or "", conv_rows, threads, truncated)
    fname = f"conversaciones-{casa_name}-{date.today().isoformat()}.pdf"
    safe = _safe_filename(fname)
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{safe}"; filename*=UTF-8\'\'{quote(fname)}',
            "Cache-Control": "no-store",
        },
    )


# ── Export metrics (CSV) ───────────────────────────────────────────
@router.get("/casas/{casa_id}/export/metricas.csv")
async def export_metricas_csv(
    casa_id: int,
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
    days: int = 30,
) -> StreamingResponse:
    casa_name = await _get_casa_name(kpi, casa_id)

    metricas = await queries.get_casa_metricas(kpi, casa_id, days=days)
    trend = await queries.get_casa_daily_trend(kpi, casa_id, days=days)

    buf = io.StringIO()
    buf.write(UTF8_BOM)
    w = csv.writer(buf, lineterminator="\n")

    w.writerow(["=== MÉTRICAS AGREGADAS ===", f"Últimos {days} días"])
    w.writerow(["métrica", "valor", "vs_previo_pct"])
    w.writerow(["conversaciones", int(metricas.convs_count.value),
                metricas.convs_count.delta_pct if metricas.convs_count.delta_pct is not None else ""])
    w.writerow(["tiempo_respuesta_medio_seg", int(metricas.avg_response_time_seconds.value),
                metricas.avg_response_time_seconds.delta_pct if metricas.avg_response_time_seconds.delta_pct is not None else ""])
    w.writerow(["conversion_media_pct", round(metricas.avg_conv_probability.value, 1),
                metricas.avg_conv_probability.delta_pct if metricas.avg_conv_probability.delta_pct is not None else ""])
    w.writerow(["red_flags_total", metricas.red_flags_count, ""])
    w.writerow([])

    w.writerow(["=== TRATO MAMAI (0-10) ==="])
    for k, v in metricas.avg_treat.items():
        w.writerow([k, v])
    w.writerow([])

    w.writerow(["=== DISTRIBUCIÓN MOOD ==="])
    w.writerow(["mood", "count"])
    for mood, cnt in metricas.mood_distribution.items():
        w.writerow([mood, cnt])
    w.writerow([])

    w.writerow(["=== TENDENCIA DIARIA ==="])
    w.writerow(["dia", "convs_analizadas", "mood_medio", "conversion_media"])
    for p in trend:
        w.writerow([p.day.isoformat(), p.count,
                    p.avg_mood_score or "", p.avg_conv or ""])

    fname = f"{casa_name}-metricas-{date.today().isoformat()}.csv"
    return _download_response(buf.getvalue(), fname, "text/csv; charset=utf-8")


# ── Export meta-analysis IA (Markdown) ─────────────────────────────
@router.get("/casas/{casa_id}/export/analisis.md")
async def export_analisis_markdown(
    casa_id: int,
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
) -> StreamingResponse:
    casa_name = await _get_casa_name(kpi, casa_id)

    latest = await queries.get_latest_meta_analysis(kpi, casa_id)
    if not latest:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Aún no hay meta-análisis IA para esta casa",
        )

    lines: list[str] = []
    lines.append(f"# Análisis IA — {casa_name}")
    lines.append("")
    lines.append(f"**Fecha de análisis:** {latest.run_at.strftime('%Y-%m-%d %H:%M UTC')}")
    lines.append(f"**Conversaciones analizadas:** {latest.conversations_analyzed}")
    lines.append("")
    lines.append("## Resumen ejecutivo")
    lines.append("")
    lines.append(latest.summary)
    lines.append("")
    lines.append("## Patrones detectados")
    lines.append("")
    lines.append("| Frecuencia | Patrón |")
    lines.append("|------------|--------|")
    for p in latest.patterns:
        freq = p.get("frequency", "—") if isinstance(p, dict) else "—"
        desc = p.get("description", "") if isinstance(p, dict) else str(p)
        lines.append(f"| **{freq}** | {desc} |")
    lines.append("")
    lines.append("## Puntos fuertes")
    lines.append("")
    for s in latest.strengths:
        lines.append(f"- {s}")
    lines.append("")
    lines.append("## Áreas a mejorar")
    lines.append("")
    for i in latest.improvements:
        lines.append(f"- {i}")
    lines.append("")
    lines.append("## Perfil típico de cliente")
    lines.append("")
    lines.append(latest.client_profile)
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("_Generado por Maxxag WA Ops · Claude Haiku 4.5_")
    lines.append("")

    fname = f"{casa_name}-analisis-IA-{date.today().isoformat()}.md"
    return _download_response("\n".join(lines), fname, "text/markdown; charset=utf-8")


# ── Export single conversation transcript (TXT) ────────────────────
@router.get("/conversation/{conversation_id}/export.txt")
async def export_transcript_txt(
    conversation_id: int,
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
) -> StreamingResponse:
    detail = await queries.get_conversation_detail(kpi, conversation_id)
    if not detail:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversación no encontrada")

    msgs = await queries.list_messages_for_conversation(kpi, conversation_id)

    contact = detail.contact_name or detail.contact_phone or "Sin nombre"
    lines: list[str] = []
    lines.append(f"Conversación #{detail.id} — {contact}")
    lines.append(f"Casa: {detail.casa_name}")
    lines.append(f"Teléfono: {detail.contact_phone or '—'}")
    lines.append(f"Iniciada: {detail.created_at.strftime('%Y-%m-%d %H:%M')}")
    lines.append("=" * 60)
    lines.append("")
    for m in msgs:
        rol = "MAMAI   " if m.direction == "out" else "CLIENTE "
        ts = m.created_at.strftime("%Y-%m-%d %H:%M")
        content = (m.body or "").replace("\n", "\n          ")
        lines.append(f"[{ts}] {rol}: {content}")
    lines.append("")
    lines.append("=" * 60)
    lines.append(f"Total: {len(msgs)} mensajes")

    fname = f"conv-{detail.id}-{contact}-{date.today().isoformat()}.txt"
    return _download_response("\n".join(lines), fname, "text/plain; charset=utf-8")


# ── Per-informe export (Markdown / DOCX / printable HTML) ──────────

def _informe_filename_stem(informe) -> str:
    casa = informe.casa_name or f"casa-{informe.account_id}"
    wa = f"-{informe.wa_label}" if informe.wa_label else ""
    return f"informe-{casa}{wa}-{informe.run_at.strftime('%Y%m%d')}"


def _format_phone_md(p: str | None) -> str:
    if not p:
        return ""
    s = "".join(ch for ch in str(p) if ch.isdigit())
    if len(s) >= 11:
        return f"+{s[:2]} {s[2:5]} {s[5:7]} {s[7:9]} {s[9:]}"
    return f"+{s}" if s else ""


def _kv(key: str, value) -> str:
    """One markdown table row: | key | value |"""
    return f"| {key} | **{value}** |"


def _informe_to_markdown(informe) -> str:
    scope = f"WhatsApp {informe.wa_label}" if informe.wa_label else "Toda la casa"
    phone = _format_phone_md(informe.wa_phone)
    k = informe.kpis or {}

    lines: list[str] = [
        f"# Informe — {informe.casa_name or 'Casa #' + str(informe.account_id)}",
        "",
        f"**Fecha:** {informe.run_at.strftime('%d %B %Y · %H:%M UTC')}",
        f"**Alcance:** {scope}" + (f" ({phone})" if phone else ""),
        f"**Conversaciones analizadas:** {informe.conversations_analyzed}",
        "",
    ]

    if informe.summary:
        lines += ["> " + informe.summary, ""]

    if informe.strengths:
        lines += ["## ✅ Qué va bien", ""]
        lines += [f"- {s}" for s in informe.strengths]
        lines.append("")
    if informe.improvements:
        lines += ["## 🔧 Qué cambiar (lo primero es lo más urgente)", ""]
        lines += [f"{i}. {imp}" for i, imp in enumerate(informe.improvements, 1)]
        lines.append("")
    if informe.client_profile:
        lines += ["## 👤 Cliente típico", "", informe.client_profile, ""]

    # 💰 Dinero (Entrega 2) — solo si el informe de bloque trae datos de cierre
    fn = k.get("funnel") or {}
    if (k.get("confirmed_bookings") or 0) > 0 or (fn.get("escriben") or 0) > 0:
        lines += [
            "## 💰 Dinero", "",
            "| Métrica | Valor |", "|--------|-------|",
            _kv("Tasa de cierre", f"{k.get('confirmed_rate_pct', 0) or 0} %"),
            _kv("Reservas cerradas", k.get("confirmed_bookings", 0) or 0),
            _kv("Ingreso estimado", f"{round(k.get('estimated_revenue_eur', 0) or 0)} €"),
            "",
            "**Embudo:** "
            f"escriben {fn.get('escriben', 0) or 0} → "
            f"precio {fn.get('preguntan_precio', 0) or 0} → "
            f"hora {fn.get('negocian_hora', 0) or 0} → "
            f"cierran {fn.get('cierran', 0) or 0}",
            "",
        ]
        if k.get("lost_reasons"):
            lines += ["**Por qué no se cierra:** " + ", ".join(
                f"{r.get('reason', '?')} ({r.get('count', 0)})" for r in k["lost_reasons"]
            ), ""]
        if k.get("channel_roi"):
            lines += ["### ROI por canal — qué web cierra", "",
                      "| Canal | Llegan | Cierran |", "|------|-------|--------|"]
            lines += [f"| {c.get('source', '—')} | {c.get('contacts', 0)} | {c.get('closed', 0)} |"
                      for c in k["channel_roi"]]
            lines.append("")

    lines += [
        "## 📊 Volumen",
        "",
        "| Métrica | Valor |",
        "|--------|-------|",
        _kv("Conversaciones totales", k.get("total_convs", informe.conversations_analyzed) or 0),
        _kv("Mensajes totales", k.get("total_msgs", 0) or 0),
        _kv("Mensajes/conv (media)", k.get("avg_msgs", 0) or 0),
        _kv("Clientes únicos", k.get("unique_clients", 0) or 0),
        _kv("Tasa de conversión", f"{k.get('conv_rate_pct', 0) or 0} %"),
        "",
        "## ✅ Estado",
        "",
        "| Métrica | Valor |",
        "|--------|-------|",
        _kv("Contestadas", k.get("answered", 0) or 0),
        _kv("Sin contestar", k.get("unanswered", 0) or 0),
        _kv("Cerradas", k.get("resolved", 0) or 0),
        _kv("Abiertas", k.get("open_count", 0) or 0),
        "",
        "## 🎯 ¿Qué piden?",
        "",
        "| Intención | Cuántas |",
        "|-----------|---------|",
        _kv("Reservas", k.get("bookings", 0) or 0),
        _kv("Cotizaciones", k.get("quotes", 0) or 0),
        _kv("Información", k.get("infos", 0) or 0),
        _kv("Quejas", k.get("complaints", 0) or 0),
        _kv("Charla", k.get("chitchat", 0) or 0),
        "",
        "## ⏱ Tiempo de respuesta",
        "",
        "| Métrica | Valor |",
        "|--------|-------|",
        _kv("Mediana (p50)", f"{k.get('p50_sec', 0) or 0} s"),
        _kv("p90", f"{round((k.get('p90_sec', 0) or 0) / 60)} min"),
        _kv("Máximo", f"{round((k.get('max_sec', 0) or 0) / 60)} min"),
        _kv("Rápido (<1min)", f"{k.get('fast_pct', 0) or 0} %"),
        "",
        "## 😀 ¿Cómo viene el cliente?",
        "",
        "| Estado | Cuántas |",
        "|--------|---------|",
        _kv("Decidido", k.get("mood_decidido", 0) or 0),
        _kv("Calentón", k.get("mood_calenton", 0) or 0),
        _kv("Curioso", k.get("mood_curioso", 0) or 0),
        _kv("Indeciso", k.get("mood_indeciso", 0) or 0),
        _kv("Enfadado", k.get("mood_enfadado", 0) or 0),
        _kv("Pelma", k.get("mood_timewaster", 0) or 0),
        "",
        "## 💬 Trato de la mamai (media 0-10)",
        "",
        "| Eje | Puntuación |",
        "|-----|------------|",
        _kv("Cariñosa", f"{k.get('avg_carinoso', 0) or 0}/10"),
        _kv("Profesional", f"{k.get('avg_profesional', 0) or 0}/10"),
        _kv("Vendedora", f"{k.get('avg_vendedor', 0) or 0}/10"),
        _kv("Seca", f"{k.get('avg_seco', 0) or 0}/10"),
        "",
    ]

    if (k.get("red_flags_total") or 0) > 0 or (k.get("escalations") or 0) > 0:
        lines += [
            "## ⚠ Alertas",
            "",
            _kv("Red flags", k.get("red_flags_total", 0) or 0),
            _kv("Escalaciones", k.get("escalations", 0) or 0),
            "",
        ]

    if k.get("hours_top"):
        lines += [
            "## ⏰ Horas punta — cuándo entra la gente", "",
            "| Hora | Mensajes |", "|------|----------|",
        ]
        for h in k["hours_top"]:
            lines.append(f"| {h.get('hour', 0):02d}:00 | {h.get('count', 0)} |")
        lines.append("")

    if k.get("wa_comparison"):
        lines += [
            "## 📱 Comparativa de WhatsApps", "",
            "| WhatsApp | Convs | Conversión | Respuesta | Seca |",
            "|----------|-------|-----------|-----------|------|",
        ]
        for w in k["wa_comparison"]:
            lines.append(
                f"| {w.get('label', '—')} | {w.get('convs', 0)} | "
                f"{w.get('conv_rate_pct', 0)}% | {w.get('p50_sec', 0)}s | "
                f"{w.get('avg_seco', 0)}/10 |"
            )
        lines.append("")

    if informe.top_referrals:
        lines += ["## 🌐 De dónde llegan", ""]
        for i, r in enumerate(informe.top_referrals[:5], 1):
            if isinstance(r, dict):
                lines.append(f"{i}. **{r.get('source', '—')}** — {r.get('count', 0)} ({r.get('pct', 0)}%)")
        lines.append("")

    if informe.top_topics:
        lines += ["## 🗣 ¿Qué piden? (top)", ""]
        for i, t in enumerate(informe.top_topics[:5], 1):
            if isinstance(t, dict):
                lines.append(f"{i}. **{t.get('topic', '—')}** — {t.get('count', 0)} ({t.get('pct', 0)}%)")
        lines.append("")

    lines += ["---", "", "_Generado por Maxxag WA Ops_", ""]
    return "\n".join(lines)


@router.get("/informes/{informe_id}/export.md")
async def export_informe_markdown(
    informe_id: int,
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
) -> StreamingResponse:
    informe = await queries.get_meta_analysis_by_id(kpi, informe_id)
    if not informe:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Informe no encontrado")
    body = _informe_to_markdown(informe)
    return _download_response(body, _informe_filename_stem(informe) + ".md",
                              "text/markdown; charset=utf-8")


@router.get("/informes/{informe_id}/print", response_class=HTMLResponse)
async def print_informe(
    request: Request,
    informe_id: int,
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
) -> HTMLResponse:
    """Printable HTML — user opens in new tab and uses Ctrl+P → Save as PDF.

    Uses the same pattern as /conversation/{id}/report. Zero new deps.
    """
    informe = await queries.get_meta_analysis_by_id(kpi, informe_id)
    if not informe:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Informe no encontrado")
    return templates.TemplateResponse(
        request,
        "print_informe.html",
        {"informe": informe, "now": datetime.now(timezone.utc)},
    )


@router.get("/informes/{informe_id}/export.docx")
async def export_informe_docx(
    informe_id: int,
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
) -> Response:
    """DOCX export — editable in Word / Google Docs."""
    try:
        from docx import Document  # type: ignore
        from docx.shared import Pt
    except ImportError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="python-docx no instalado — rebuild del contenedor necesario",
        ) from exc

    informe = await queries.get_meta_analysis_by_id(kpi, informe_id)
    if not informe:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Informe no encontrado")

    casa_label = informe.casa_name or f"Casa #{informe.account_id}"
    scope = f"WhatsApp {informe.wa_label}" if informe.wa_label else "Toda la casa"
    phone = _format_phone_md(informe.wa_phone)
    if phone:
        scope = f"{scope} ({phone})"

    k = informe.kpis or {}

    doc = Document()
    doc.add_heading(f"Informe — {casa_label}", level=0)
    sub = doc.add_paragraph()
    sub.add_run(
        f"{informe.run_at.strftime('%d/%m/%Y %H:%M UTC')} · {scope} · "
        f"{informe.conversations_analyzed} conversaciones analizadas"
    ).italic = True

    if informe.summary:
        p = doc.add_paragraph()
        r = p.add_run(informe.summary)
        r.italic = True

    def _kv_table(rows: list[tuple[str, str]]):
        """Helper: render a key/value table with bold values."""
        tbl = doc.add_table(rows=len(rows), cols=2)
        tbl.style = "Light Grid Accent 1"
        for i, (label, value) in enumerate(rows):
            tbl.rows[i].cells[0].text = label
            cell = tbl.rows[i].cells[1]
            cell.text = ""
            run = cell.paragraphs[0].add_run(str(value))
            run.bold = True

    if informe.strengths:
        doc.add_heading("Qué va bien", level=1)
        for s in informe.strengths:
            doc.add_paragraph(f"• {s}")
    if informe.improvements:
        doc.add_heading("Qué cambiar (lo primero es lo más urgente)", level=1)
        for i, imp in enumerate(informe.improvements, 1):
            doc.add_paragraph(f"{i}. {imp}")
    if informe.client_profile:
        doc.add_heading("Cliente típico", level=1)
        doc.add_paragraph(informe.client_profile)

    # 💰 Dinero (Entrega 2) — solo si el informe de bloque trae datos de cierre
    fn = k.get("funnel") or {}
    if (k.get("confirmed_bookings") or 0) > 0 or (fn.get("escriben") or 0) > 0:
        doc.add_heading("Dinero", level=1)
        _kv_table([
            ("Tasa de cierre", f"{k.get('confirmed_rate_pct', 0) or 0} %"),
            ("Reservas cerradas", k.get("confirmed_bookings", 0) or 0),
            ("Ingreso estimado", f"{round(k.get('estimated_revenue_eur', 0) or 0)} €"),
        ])
        doc.add_paragraph(
            f"Embudo: escriben {fn.get('escriben', 0) or 0} → precio {fn.get('preguntan_precio', 0) or 0} "
            f"→ hora {fn.get('negocian_hora', 0) or 0} → cierran {fn.get('cierran', 0) or 0}"
        )
        if k.get("lost_reasons"):
            doc.add_paragraph("Por qué no se cierra: " + ", ".join(
                f"{r.get('reason', '?')} ({r.get('count', 0)})" for r in k["lost_reasons"]
            ))
        if k.get("channel_roi"):
            doc.add_heading("ROI por canal — qué web cierra", level=2)
            for c in k["channel_roi"]:
                doc.add_paragraph(
                    f"• {c.get('source', '—')}: llegan {c.get('contacts', 0)}, cierran {c.get('closed', 0)}"
                )

    doc.add_heading("Volumen", level=1)
    _kv_table([
        ("Conversaciones totales", k.get("total_convs", informe.conversations_analyzed) or 0),
        ("Mensajes totales", k.get("total_msgs", 0) or 0),
        ("Mensajes/conv (media)", k.get("avg_msgs", 0) or 0),
        ("Clientes únicos", k.get("unique_clients", 0) or 0),
        ("Tasa de conversión", f"{k.get('conv_rate_pct', 0) or 0} %"),
    ])

    doc.add_heading("Estado", level=1)
    _kv_table([
        ("Contestadas", k.get("answered", 0) or 0),
        ("Sin contestar", k.get("unanswered", 0) or 0),
        ("Cerradas", k.get("resolved", 0) or 0),
        ("Abiertas", k.get("open_count", 0) or 0),
    ])

    doc.add_heading("¿Qué piden?", level=1)
    _kv_table([
        ("Reservas", k.get("bookings", 0) or 0),
        ("Cotizaciones", k.get("quotes", 0) or 0),
        ("Información", k.get("infos", 0) or 0),
        ("Quejas", k.get("complaints", 0) or 0),
        ("Charla", k.get("chitchat", 0) or 0),
    ])

    doc.add_heading("Tiempo de respuesta", level=1)
    _kv_table([
        ("Mediana (p50)", f"{k.get('p50_sec', 0) or 0} s"),
        ("p90", f"{round((k.get('p90_sec', 0) or 0) / 60)} min"),
        ("Máximo", f"{round((k.get('max_sec', 0) or 0) / 60)} min"),
        ("Rápido (<1min)", f"{k.get('fast_pct', 0) or 0} %"),
    ])

    doc.add_heading("¿Cómo viene el cliente?", level=1)
    _kv_table([
        ("Decidido", k.get("mood_decidido", 0) or 0),
        ("Calentón", k.get("mood_calenton", 0) or 0),
        ("Curioso", k.get("mood_curioso", 0) or 0),
        ("Indeciso", k.get("mood_indeciso", 0) or 0),
        ("Enfadado", k.get("mood_enfadado", 0) or 0),
        ("Pelma", k.get("mood_timewaster", 0) or 0),
    ])

    doc.add_heading("Trato de la mamai (media 0-10)", level=1)
    _kv_table([
        ("Cariñosa", f"{k.get('avg_carinoso', 0) or 0}/10"),
        ("Profesional", f"{k.get('avg_profesional', 0) or 0}/10"),
        ("Vendedora", f"{k.get('avg_vendedor', 0) or 0}/10"),
        ("Seca", f"{k.get('avg_seco', 0) or 0}/10"),
    ])

    if (k.get("red_flags_total") or 0) > 0 or (k.get("escalations") or 0) > 0:
        doc.add_heading("Alertas", level=1)
        _kv_table([
            ("Red flags", k.get("red_flags_total", 0) or 0),
            ("Escalaciones", k.get("escalations", 0) or 0),
        ])

    if k.get("hours_top"):
        doc.add_heading("Horas punta — cuándo entra la gente", level=1)
        _kv_table([
            (f"{h.get('hour', 0):02d}:00", f"{h.get('count', 0)} mensajes")
            for h in k["hours_top"]
        ])

    if k.get("wa_comparison"):
        doc.add_heading("Comparativa de WhatsApps", level=1)
        wt = doc.add_table(rows=1, cols=5)
        wt.style = "Light Grid Accent 1"
        hc = wt.rows[0].cells
        hc[0].text, hc[1].text, hc[2].text, hc[3].text, hc[4].text = (
            "WhatsApp", "Convs", "Conversión", "Respuesta", "Seca"
        )
        for w in k["wa_comparison"]:
            rc = wt.add_row().cells
            rc[0].text = str(w.get("label", "—"))
            rc[1].text = str(w.get("convs", 0))
            rc[2].text = f"{w.get('conv_rate_pct', 0)}%"
            rc[3].text = f"{w.get('p50_sec', 0)} s"
            rc[4].text = f"{w.get('avg_seco', 0)}/10"

    if informe.top_referrals:
        doc.add_heading("De dónde llegan (top)", level=1)
        for i, r in enumerate(informe.top_referrals[:5], 1):
            if isinstance(r, dict):
                doc.add_paragraph(
                    f"{i}. {r.get('source', '—')} — {r.get('count', 0)} ({r.get('pct', 0)}%)",
                    style="List Number",
                )

    if informe.top_topics:
        doc.add_heading("¿Qué piden? (top)", level=1)
        for i, t in enumerate(informe.top_topics[:5], 1):
            if isinstance(t, dict):
                doc.add_paragraph(
                    f"{i}. {t.get('topic', '—')} — {t.get('count', 0)} ({t.get('pct', 0)}%)",
                    style="List Number",
                )

    doc.add_paragraph()
    footer = doc.add_paragraph()
    footer.add_run(
        f"Maxxag Ops · Generado {datetime.now(timezone.utc).strftime('%d/%m/%Y %H:%M')} · informe #{informe.id}"
    ).italic = True

    buf = io.BytesIO()
    doc.save(buf)
    buf.seek(0)

    fname = _informe_filename_stem(informe) + ".docx"
    safe = _safe_filename(fname)
    return Response(
        content=buf.read(),
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={
            "Content-Disposition": f'attachment; filename="{safe}"; filename*=UTF-8\'\'{quote(fname)}',
            "Cache-Control": "no-store",
        },
    )
