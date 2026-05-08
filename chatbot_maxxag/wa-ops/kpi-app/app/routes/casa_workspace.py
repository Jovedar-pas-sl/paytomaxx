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
    period: str | None = Query(None),
    wa: str = Query("all"),
    unanswered: bool = Query(False),
    search: str = Query(""),
    mood: str = Query(""),
    status: str = Query(""),
) -> HTMLResponse:
    if tab not in VALID_TABS:
        tab = "chats"
    # Default period depends on the active tab:
    # - chats → 'all' (user wants to see everything historic)
    # - metricas/problemas/analisis → '30d' (sensible default for stats)
    if period is None or period not in VALID_PERIODS:
        period = "all" if tab == "chats" else "30d"
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
        tab_ctx = await _chats_tab(
            kpi, casa_id, wa_number_id, days, unanswered,
            search=search, mood=mood, status=status,
        )
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
            "active_unanswered": unanswered,
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


async def _chats_tab(
    kpi,
    casa_id: int,
    wa_number_id: int | None = None,
    days: int = 3650,
    unanswered: bool = False,
    search: str = "",
    mood: str = "",
    status: str = "",
) -> dict:
    # since_days=None means "all" (3650 days = 10 years which is effectively no
    # filter); pass the real value otherwise so the SQL filter applies.
    since_days = None if days >= 3650 else days
    search_q = (search or "").strip() or None
    mood_q = mood if mood in {"curioso", "decidido", "calenton", "indeciso", "enfadado", "timewaster"} else None
    status_q = status if status in {"open", "resolved", "pending"} else None
    rows, total = await queries.list_conversations(
        kpi,
        casa_id=casa_id,
        wa_number_id=wa_number_id,
        since_days=since_days,
        unanswered_only=unanswered,
        search=search_q,
        mood=mood_q,
        status=status_q,
        limit=50,
        offset=0,
    )
    # 24h-window count for the analyze banner (independent of the chat filters)
    unanalyzed = await queries.count_unanalyzed_for_casa(
        kpi, casa_id,
        wa_number_id=wa_number_id,
        since_hours=24,
        include_open=True,
        redo_dirty=True,
    )
    # Total convs awaiting reply — drives the "Sin contestar (N)" chip count.
    unanswered_count = await queries.count_unanswered_for_casa(
        kpi, casa_id,
        wa_number_id=wa_number_id,
        since_days=since_days,
    )
    return {
        "chat_rows": rows,
        "chat_total": total,
        "unanalyzed_count": unanalyzed,
        "unanswered_count": unanswered_count,
        "wa_number_id": wa_number_id,
        "active_search": search_q or "",
        "active_mood": mood_q or "",
        "active_status": status_q or "",
    }


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
    if wa_number_id is not None:
        analyzed_count = await queries.count_analyzed_for_casa(
            kpi, casa_id, wa_number_id=wa_number_id
        )
    else:
        analyzed_count = await queries.count_analyzed_for_casa(kpi, casa_id)

    # Pending convs in the last 24h that need analyzing (or re-analyzing) —
    # informs the user up front roughly how long the bulk phase will take.
    pending_count = await queries.count_unanalyzed_for_casa(
        kpi, casa_id,
        wa_number_id=wa_number_id,
        since_hours=24,
        include_open=True,
        redo_dirty=True,
    )

    analysis_history, analysis_total = await queries.list_analysis_history(
        kpi, casa_id, wa_number_id=wa_number_id, limit=50, offset=0,
    )
    return {
        "meta_latest": latest,
        "meta_history": history,
        "analyzed_count": analyzed_count,
        "pending_count": pending_count,
        # Auto-cadena handles low-data cases internally; the gate is gone.
        # Keep the var for backwards-compat with the template's older branches.
        "can_run_meta": True,
        "analysis_history": analysis_history,
        "analysis_total": analysis_total,
        "wa_number_id": wa_number_id,
    }
