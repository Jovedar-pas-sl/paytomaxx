"""Métricas — página pro de KPIs: marketing + comparativa por local (casa).

Agrega el ÚLTIMO informe (casa_meta_analysis) de cada casa dentro del período.
Estructura en 3 capas (research del sector): (1) hero ejecutivo, (2) marketing
(canales + embudo + motivos de pérdida), (3) detalle por local + demanda.
Defensivo: cada bloque solo se computa/renderiza si hay datos (los informes los
genera el analizador, así que la frescura depende del último análisis por casa).
Solo admin/super-admin.
"""
from __future__ import annotations

from fastapi import APIRouter, Query, Request
from fastapi.responses import HTMLResponse

from app import queries
from app.deps import KpiDB, RequireAdmin
from app.template_env import templates

router = APIRouter()

_PERIODS: dict[str, int] = {"7d": 7, "30d": 30, "90d": 90, "365d": 365, "all": 3650}
_MOODS = ("decidido", "curioso", "calenton", "indeciso", "enfadado", "timewaster")


def _merge_counts(items: list, key: str, *, extra: tuple[str, ...] = ()) -> list[dict]:
    """Funde dicts por `key`, sumando 'count' (+ campos numéricos extra)."""
    agg: dict[str, dict] = {}
    for it in items:
        if not isinstance(it, dict):
            continue
        k = (it.get(key) or "").strip()
        if not k:
            continue
        slot = agg.setdefault(k, {key: k, "count": 0, **{e: 0 for e in extra}})
        slot["count"] += int(it.get("count") or 0)
        for e in extra:
            slot[e] += int(it.get(e) or 0)
    return sorted(agg.values(), key=lambda x: x["count"], reverse=True)


@router.get("/metricas", response_class=HTMLResponse)
async def metricas_page(
    request: Request,
    user: RequireAdmin,
    kpi: KpiDB,
    period: str = Query("90d"),
) -> HTMLResponse:
    if period not in _PERIODS:
        period = "90d"
    # LIVE volume over the selected period (changes with 7d/30d/90d). Computed
    # straight from message/conversation — separate from the AI-informe snapshot.
    vol = await queries.period_volume(kpi, _PERIODS[period])
    metas = await queries.list_latest_meta_per_casa(kpi, days=_PERIODS[period])

    per_casa: list[dict] = []
    channel_leads: dict[str, int] = {}
    channel_closed: dict[str, int] = {}
    funnel = {"escriben": 0, "preguntan_precio": 0, "negocian_hora": 0, "cierran": 0}
    has_funnel = False
    lost: list = []
    chicas: list = []
    services: list = []
    tot_convs = 0
    closed_sum = 0
    conv_rate_weighted = 0.0

    for m in metas:
        k = m["kpis"] or {}
        convs = int(k.get("total_convs") or m["conversations_analyzed"] or 0)
        cr = float(k.get("conv_rate_pct") or k.get("confirmed_rate_pct") or 0)
        tot_convs += convs
        conv_rate_weighted += cr * convs
        closed_est = round(convs * cr / 100)
        closed_sum += closed_est
        moods = {mm: int(k.get("mood_" + mm) or 0) for mm in _MOODS}
        top_mood = max(moods, key=moods.get) if any(moods.values()) else None
        per_casa.append({
            "name": m["casa_name"],
            "convs": convs,
            "conv_rate": round(cr),
            "closed": closed_est,
            "response_sec": int(k.get("p50_sec") or 0),
            "unanswered": int(k.get("unanswered") or 0),
            "top_mood": top_mood,
            "run_at": m["run_at"],
        })
        # Marketing — canales: top_referrals (leads) + channel_roi (cierres) si existe
        for ref in (m["top_referrals"] or []):
            src = (ref.get("source") or "").strip() if isinstance(ref, dict) else ""
            if src:
                channel_leads[src] = channel_leads.get(src, 0) + int(ref.get("count") or 0)
        for ch in (k.get("channel_roi") or []):
            src = (ch.get("source") or "").strip() if isinstance(ch, dict) else ""
            if src:
                channel_leads[src] = channel_leads.get(src, 0) + int(ch.get("contacts") or 0)
                channel_closed[src] = channel_closed.get(src, 0) + int(ch.get("closed") or 0)
        f = k.get("funnel")
        if isinstance(f, dict):
            has_funnel = True
            for step in funnel:
                funnel[step] += int(f.get(step) or 0)
        lost += k.get("lost_reasons") or []
        chicas += k.get("top_chicas") or []
        services += k.get("top_services") or []

    channels: list[dict] = []
    for src, leads in channel_leads.items():
        cl = channel_closed.get(src, 0)
        channels.append({
            "source": src,
            "leads": leads,
            "closed": cl,
            "close_rate": (round(100 * cl / leads) if leads and cl else None),
        })
    channels.sort(key=lambda x: x["leads"], reverse=True)

    overall_close = round(conv_rate_weighted / tot_convs) if tot_convs else 0

    return templates.TemplateResponse(
        request,
        "metricas.html",
        {
            "user": user,
            "period": period,
            "period_options": list(_PERIODS.keys()),
            "vol": vol,
            "metas_count": len(metas),
            "per_casa": sorted(per_casa, key=lambda x: x["convs"], reverse=True),
            "channels": channels[:12],
            "funnel": funnel if has_funnel else None,
            "lost": _merge_counts(lost, "reason")[:8],
            "chicas": _merge_counts(chicas, "name", extra=("closed",))[:10],
            "services": _merge_counts(services, "service")[:8],
            "tot_convs": tot_convs,
            "closed_sum": closed_sum,
            "overall_close": overall_close,
        },
    )
