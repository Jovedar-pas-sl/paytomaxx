"""Casa workspace — single page with tabs.

Routes:
  GET /casas/<id>?tab=<chats|metricas|problemas|analisis>&period=<24h|7d|30d|90d|all>
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import HTMLResponse
from app import queries
from app.deps import CurrentUser, KpiDB, SettingsDep
from app.template_env import templates

router = APIRouter()
Tab = Literal["chats", "metricas", "problemas", "analisis"]
Period = Literal["24h", "7d", "30d", "90d", "all"]

VALID_TABS: set[str] = {"chats", "metricas", "problemas", "analisis"}
VALID_PERIODS: set[str] = {"24h", "7d", "30d", "90d", "all"}

PERIOD_DAYS: dict[str, int] = {"24h": 1, "7d": 7, "30d": 30, "90d": 90, "all": 3650}


@router.get("/casas/{casa_id}", response_class=HTMLResponse)
async def casa_workspace(
    casa_id: int,
    request: Request,
    user: CurrentUser,
    kpi: KpiDB,
    settings: SettingsDep,
    tab: str = Query("chats"),
    period: str = Query("30d"),
    wa: str = Query("all"),
) -> HTMLResponse:
    if tab not in VALID_TABS:
        tab = "chats"
    if period not in VALID_PERIODS:
        period = "30d"
    days = PERIOD_DAYS[period]

    # Resolve wa param: "all" or a wa_number_id
    wa_number_id: int | None = None
    if wa != "all":
        try:
            wa_number_id = int(wa)
        except ValueError:
            wa = "all"

    async with kpi.acquire() as conn:
        casa_row = await conn.fetchrow(
            "SELECT id, name FROM casa WHERE id = $1",
            casa_id,
        )
    if not casa_row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Casa no encontrada",
        )

    casa_name = casa_row["name"]

    # Always fetch WA numbers of this casa (for sub-tabs)
    wa_numbers = await queries.list_wa_numbers_for_casa(kpi, casa_id)

    header_ctx = await _build_header(kpi, casa_id, casa_name)

    tab_ctx: dict = {}
    if tab == "chats":
        tab_ctx = await _chats_tab(kpi, casa_id, wa_number_id)
    elif tab == "metricas":
        tab_ctx = await _metricas_tab(kpi, casa_id, days)
    elif tab == "problemas":
        tab_ctx = await _problemas_tab(kpi, casa_id, days)
    elif tab == "analisis":
        tab_ctx = await _analisis_tab(kpi, casa_id, days, wa_number_id)

    return templates.TemplateResponse(
        request,
        "casa_workspace.html",
        {
            "user": user,
            "casa_id": casa_id,
            "casa_name": casa_name,
            "active_tab": tab,
            "active_period": period,
            "active_wa": wa,
            "wa_numbers": wa_numbers,
            "period_options": ["24h", "7d", "30d", "90d", "all"],
            "admin_url": None,
            **header_ctx,
            **tab_ctx,
        },
    )


# ── Tab helpers ───────────────────────────────────────────────────
async def _build_header(kpi, casa_id: int, casa_name: str) -> dict:
    return {"header": await queries.get_casa_header(kpi, casa_id, casa_name)}


async def _chats_tab(kpi, casa_id: int, wa_number_id: int | None = None) -> dict:
    rows, total = await queries.list_conversations(
        kpi, casa_id=casa_id, wa_number_id=wa_number_id, limit=50, offset=0
    )
    unanalyzed = await queries.count_unanalyzed_for_casa(kpi, casa_id)
    return {"chat_rows": rows, "chat_total": total, "unanalyzed_count": unanalyzed}


async def _metricas_tab(kpi, casa_id: int, days: int) -> dict:
    metricas = await queries.get_casa_metricas(kpi, casa_id, days=days)
    trend = await queries.get_casa_daily_trend(kpi, casa_id, days=days)
    top, bottom = await queries.get_casa_top_bottom_convs(kpi, casa_id, limit=5)
    return {
        "metricas": metricas,
        "trend": trend,
        "top_convs": top,
        "bottom_convs": bottom,
    }


async def _problemas_tab(kpi, casa_id: int, days: int) -> dict:
    alerts = await queries.get_casa_alerts(kpi, casa_id, days=days)
    return {"alerts": alerts}


async def _analisis_tab(kpi, casa_id: int, days: int, wa_number_id: int | None = None) -> dict:
    latest = await queries.get_latest_meta_analysis(kpi, casa_id)
    history = await queries.list_meta_analyses(
        kpi, casa_id, days=days, limit=10, wa_number_id=wa_number_id
    )
    analyzed_count = await queries.count_analyzed_for_casa(kpi, casa_id)
    analysis_history, analysis_total = await queries.list_analysis_history(
        kpi, casa_id, wa_number_id=wa_number_id, limit=50, offset=0,
    )
    return {
        "meta_latest": latest,
        "meta_history": history,
        "analyzed_count": analyzed_count,
        "can_run_meta": analyzed_count >= 10,
        "analysis_history": analysis_history,
        "analysis_total": analysis_total,
    }
