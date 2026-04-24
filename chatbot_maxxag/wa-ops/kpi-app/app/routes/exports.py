"""Export endpoints: CSV for lists, Markdown for IA reports, TXT for transcripts.

All endpoints are behind CurrentUser auth. UTF-8 BOM added to CSVs so Excel
detects the encoding correctly for ñ/emojis.
"""

from __future__ import annotations

import csv
import io
from datetime import date
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import StreamingResponse

from app import queries
from app.deps import CurrentUser, KpiDB

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
