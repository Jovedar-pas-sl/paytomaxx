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

    rows, _ = await queries.list_conversations(kpi, casa_id=casa_id, limit=1000, offset=0)

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


# ── Per-conversation analysis report (printable HTML → PDF) ───────

async def _fetch_conversation_report(kpi, conversation_id: int) -> dict:
    """Load conversation detail + analysis + messages for the report view."""
    detail = await queries.get_conversation_detail(kpi, conversation_id)
    if not detail:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversación no encontrada")

    async with kpi.acquire() as conn:
        analysis_row = await conn.fetchrow(
            "SELECT * FROM analysis WHERE conversation_id = $1", conversation_id,
        )

    analysis_dict: dict | None = None
    if analysis_row:
        analysis_dict = dict(analysis_row)
        for field in ("coaching", "red_flags", "intent", "next_action", "escalation"):
            v = analysis_dict.get(field)
            if isinstance(v, str):
                try:
                    analysis_dict[field] = _json.loads(v)
                except (TypeError, ValueError):
                    analysis_dict[field] = None

    messages = await queries.list_messages_for_conversation(kpi, conversation_id)
    contact_label = detail.contact_name or detail.contact_phone or detail.contact_jid or "Contacto"

    return {
        "detail": detail,
        "analysis": analysis_dict,
        "messages": messages,
        "contact_label": contact_label,
    }


@router.get("/conversation/{conversation_id}/report", response_class=HTMLResponse)
async def report_conversation_html(
    request: Request,
    conversation_id: int,
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
    transcript: int = 1,  # ?transcript=0 para omitir la transcripción
) -> HTMLResponse:
    """Printable HTML report. Usuario abre en nueva pestaña → Ctrl+P → Guardar como PDF."""
    ctx = await _fetch_conversation_report(kpi, conversation_id)
    detail = ctx["detail"]
    return templates.TemplateResponse(
        request,
        "report_conversation.html",
        {
            "conv": detail,
            "casa_name": detail.casa_name,
            "wa_label": detail.wa_label,
            "contact_label": ctx["contact_label"],
            "analysis": ctx["analysis"],
            "messages": ctx["messages"],
            "msg_count": len(ctx["messages"]),
            "include_transcript": bool(transcript),
            "now": datetime.now(timezone.utc),
        },
    )


@router.get("/conversation/{conversation_id}/report.docx")
async def report_conversation_docx(
    conversation_id: int,
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
    transcript: int = 0,  # transcript opt-in in DOCX (makes the file huge)
) -> Response:
    """DOCX analysis report — editable in Word / Google Docs."""
    try:
        from docx import Document  # type: ignore
        from docx.shared import Pt, RGBColor
    except ImportError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="python-docx no instalado — rebuild del contenedor necesario",
        ) from exc

    ctx = await _fetch_conversation_report(kpi, conversation_id)
    detail = ctx["detail"]
    analysis = ctx["analysis"]

    doc = Document()
    doc.add_heading(f"Informe de conversación #{detail.id}", level=0)
    sub = doc.add_paragraph()
    sub.add_run(f"{detail.casa_name} · {detail.wa_label or 'WhatsApp'} · {ctx['contact_label']}").italic = True

    # Meta table
    tbl = doc.add_table(rows=1, cols=4)
    tbl.style = "Light Grid Accent 1"
    hdr = tbl.rows[0].cells
    hdr[0].text = "Conversación"
    hdr[1].text = "Mensajes"
    hdr[2].text = "Inicio"
    hdr[3].text = "Analizado"
    row = tbl.add_row().cells
    row[0].text = f"#{detail.id}"
    row[1].text = str(len(ctx["messages"]))
    row[2].text = detail.created_at.strftime("%d/%m/%Y %H:%M")
    row[3].text = analysis["analyzed_at"].strftime("%d/%m/%Y %H:%M") if analysis else "—"

    if not analysis:
        doc.add_paragraph()
        p = doc.add_paragraph()
        r = p.add_run("Esta conversación aún no tiene análisis IA. Solicita un análisis y vuelve a generar el informe.")
        r.bold = True
    else:
        # Escalation
        esc = analysis.get("escalation") or {}
        if esc.get("should_escalate"):
            doc.add_heading(f"⚠ Escalar a admin · {esc.get('severity', 'n/a')}", level=2)
            if esc.get("reason"):
                doc.add_paragraph(esc["reason"])
            for t in esc.get("triggers") or []:
                doc.add_paragraph(f"• {t}")

        # Intent
        intent = analysis.get("intent") or {}
        if intent:
            doc.add_heading("Intención del cliente", level=2)
            p = doc.add_paragraph()
            p.add_run(f"{intent.get('primary', '—')}").bold = True
            if intent.get("secondary"):
                p.add_run(f"  · {', '.join(intent['secondary'])}")
            p.add_run(f"  · confianza {int((intent.get('confidence') or 0) * 100)}%")
            doc.add_paragraph(intent.get("reasoning") or "")

        # Next action
        na = analysis.get("next_action") or {}
        if na:
            doc.add_heading("Próxima acción", level=2)
            p = doc.add_paragraph()
            p.add_run(f"{na.get('action', '—')}").bold = True
            p.add_run(f"  · urgencia: {na.get('urgency', '—')}")
            doc.add_paragraph(na.get("why") or "")
            if na.get("suggested_message"):
                doc.add_heading("Mensaje sugerido", level=3)
                para = doc.add_paragraph(na["suggested_message"])
                para.runs[0].font.size = Pt(11)

        # Mood + conversion
        doc.add_heading("Estado del cliente", level=2)
        doc.add_paragraph(f"Mood: {analysis.get('mood_label', '—')} ({analysis.get('mood_score', 0)}/10)")
        if analysis.get("mood_reasoning"):
            doc.add_paragraph(analysis["mood_reasoning"])
        pct = int((analysis.get("conv_probability") or 0) * 100)
        doc.add_paragraph(f"Probabilidad de conversión: {pct}%")

        # Treatment
        doc.add_heading("Trato de la mamai", level=2)
        for label, val in [
            ("Cariñoso",    analysis.get("treat_carinoso", 0)),
            ("Profesional", analysis.get("treat_profesional", 0)),
            ("Vendedor",    analysis.get("treat_vendedor", 0)),
            ("Seco",        analysis.get("treat_seco", 0)),
        ]:
            doc.add_paragraph(f"{label}: {val}/10")

        # Response times
        doc.add_heading("Tiempos de respuesta", level=2)
        doc.add_paragraph(
            f"p50 = {(analysis.get('rt_p50') or 0) // 1000} s · "
            f"p90 = {(analysis.get('rt_p90') or 0) // 60000} min · "
            f"max = {(analysis.get('rt_max') or 0) // 60000} min"
        )

        # Red flags
        flags = analysis.get("red_flags") or []
        if isinstance(flags, list) and flags:
            doc.add_heading("Red flags", level=2)
            for f in flags:
                if isinstance(f, dict):
                    doc.add_paragraph(f"• {f.get('type', '?')}: {f.get('reason', '')}")

        # Coaching
        coaching = analysis.get("coaching") or {}
        if coaching:
            doc.add_heading("Coaching — cómo mejorar la próxima vez", level=1)
            if coaching.get("overall"):
                doc.add_paragraph(coaching["overall"])
            if coaching.get("went_well"):
                doc.add_heading("Bien hecho", level=3)
                for w in coaching["went_well"]:
                    doc.add_paragraph(f"• {w}")
            if coaching.get("missed_opportunities"):
                doc.add_heading("Oportunidades perdidas", level=3)
                for mo in coaching["missed_opportunities"]:
                    if isinstance(mo, dict):
                        p = doc.add_paragraph()
                        r = p.add_run(f"“{mo.get('moment', '')}”")
                        r.italic = True
                        doc.add_paragraph(f"→ {mo.get('suggestion', '')}")
            if coaching.get("response_tips"):
                doc.add_heading("Tips de respuesta", level=3)
                for t in coaching["response_tips"]:
                    doc.add_paragraph(f"• {t}")
            if coaching.get("tone_tips"):
                doc.add_heading("Tips de tono", level=3)
                for t in coaching["tone_tips"]:
                    doc.add_paragraph(f"• {t}")
            if coaching.get("example_reply"):
                doc.add_heading("Ejemplo de respuesta ideal", level=3)
                doc.add_paragraph(coaching["example_reply"])

    if transcript:
        doc.add_heading("Transcripción", level=1)
        for m in ctx["messages"]:
            role = "MAMAI" if m.direction == "out" else "CLIENTE"
            ts = m.created_at.strftime("%d/%m %H:%M")
            body = m.body or ("(media)" if m.media_url else "")
            doc.add_paragraph(f"[{ts}] {role}: {body}")

    doc.add_paragraph()
    footer = doc.add_paragraph()
    footer.add_run(
        f"Informe generado por Maxxag Ops · {datetime.now(timezone.utc).strftime('%d/%m/%Y %H:%M')} · conv #{detail.id}"
    ).italic = True

    buf = io.BytesIO()
    doc.save(buf)
    buf.seek(0)

    fname = f"conv-{detail.id}-{ctx['contact_label']}-{date.today().isoformat()}.docx"
    safe = _safe_filename(fname)
    return Response(
        content=buf.read(),
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={
            "Content-Disposition": f'attachment; filename="{safe}"; filename*=UTF-8\'\'{quote(fname)}',
            "Cache-Control": "no-store",
        },
    )


# ── Per-informe export (Markdown / DOCX / printable HTML) ──────────

def _informe_filename_stem(informe) -> str:
    casa = informe.casa_name or f"casa-{informe.account_id}"
    wa = f"-{informe.wa_label}" if informe.wa_label else ""
    return f"informe-{casa}{wa}-{informe.run_at.strftime('%Y%m%d')}"


def _informe_to_markdown(informe) -> str:
    scope = f"WhatsApp {informe.wa_label}" if informe.wa_label else "Toda la casa"
    lines: list[str] = [
        f"# Informe IA — {informe.casa_name or 'Casa #' + str(informe.account_id)}",
        "",
        f"**Fecha:** {informe.run_at.strftime('%d %B %Y · %H:%M UTC')}",
        f"**Alcance:** {scope}",
        f"**Conversaciones analizadas:** {informe.conversations_analyzed}",
        "",
        "## Resumen ejecutivo",
        "",
        informe.summary,
        "",
        "## Patrones detectados",
        "",
        "| Frecuencia | Patrón |",
        "|------------|--------|",
    ]
    for p in informe.patterns or []:
        freq = p.get("frequency", "—") if isinstance(p, dict) else "—"
        desc = p.get("description", "") if isinstance(p, dict) else str(p)
        lines.append(f"| **{freq}** | {desc} |")

    lines += ["", "## Puntos fuertes", ""]
    for s in informe.strengths or []:
        lines.append(f"- {s}")

    lines += ["", "## Áreas a mejorar", ""]
    for i in informe.improvements or []:
        lines.append(f"- {i}")

    lines += ["", "## Perfil típico de cliente", "", informe.client_profile or ""]

    if informe.top_topics:
        lines += ["", "## De qué más habla", ""]
        for t in informe.top_topics:
            if isinstance(t, dict):
                lines.append(f"- **{t.get('topic', '—')}** — {t.get('count', 0)} ({t.get('pct', 0)}%)")

    if informe.avoided_topics:
        lines += ["", "## Temas que no toca", ""]
        for t in informe.avoided_topics:
            lines.append(f"- {t}")

    if informe.top_referrals:
        lines += ["", "## De dónde llegan los clientes", ""]
        for r in informe.top_referrals:
            if isinstance(r, dict):
                lines.append(f"- **{r.get('source', '—')}** — {r.get('count', 0)} ({r.get('pct', 0)}%)")

    lines += ["", "---", "", "_Generado por Maxxag WA Ops · Claude Haiku 4.5_", ""]
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

    doc = Document()
    doc.add_heading(f"Informe IA — {casa_label}", level=0)
    sub = doc.add_paragraph()
    sub.add_run(
        f"{informe.run_at.strftime('%d/%m/%Y %H:%M UTC')} · {scope} · "
        f"{informe.conversations_analyzed} conversaciones analizadas"
    ).italic = True

    doc.add_heading("Resumen ejecutivo", level=1)
    doc.add_paragraph(informe.summary or "")

    if informe.patterns:
        doc.add_heading("Patrones detectados", level=1)
        for p in informe.patterns:
            if not isinstance(p, dict):
                continue
            para = doc.add_paragraph(style="List Bullet")
            r = para.add_run(f"[{p.get('frequency', '—').upper()}] ")
            r.bold = True
            para.add_run(p.get("description", ""))

    if informe.strengths:
        doc.add_heading("Puntos fuertes", level=1)
        for s in informe.strengths:
            doc.add_paragraph(s, style="List Bullet")

    if informe.improvements:
        doc.add_heading("Áreas a mejorar", level=1)
        for i in informe.improvements:
            doc.add_paragraph(i, style="List Bullet")

    if informe.client_profile:
        doc.add_heading("Perfil típico de cliente", level=1)
        doc.add_paragraph(informe.client_profile)

    if informe.top_topics:
        doc.add_heading("De qué más habla", level=1)
        for t in informe.top_topics:
            if isinstance(t, dict):
                doc.add_paragraph(
                    f"{t.get('topic', '—')} — {t.get('count', 0)} ({t.get('pct', 0)}%)",
                    style="List Bullet",
                )

    if informe.avoided_topics:
        doc.add_heading("Temas que no toca", level=1)
        for t in informe.avoided_topics:
            doc.add_paragraph(t, style="List Bullet")

    if informe.top_referrals:
        doc.add_heading("De dónde llegan los clientes", level=1)
        for r in informe.top_referrals:
            if isinstance(r, dict):
                doc.add_paragraph(
                    f"{r.get('source', '—')} — {r.get('count', 0)} ({r.get('pct', 0)}%)",
                    style="List Bullet",
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
