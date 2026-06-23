"""Export endpoints: CSV for lists, Markdown for IA reports, TXT for transcripts,
printable HTML + DOCX for per-conversation analysis reports.

All endpoints are behind CurrentUser auth. UTF-8 BOM added to CSVs so Excel
detects the encoding correctly for ñ/emojis.
"""

from __future__ import annotations

import csv
import io
import json as _json
from datetime import date, datetime, timezone
from urllib.parse import quote

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
