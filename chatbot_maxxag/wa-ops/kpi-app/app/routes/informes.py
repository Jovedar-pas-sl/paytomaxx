"""Informes — global archive of meta-analyses across all casas.

Routes:
  GET /informes                  — list all meta-analyses (filterable by casa)
  GET /informes/{id}             — single informe detail page
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import HTMLResponse

from app import queries
from app.deps import CurrentUser, KpiDB
from app.template_env import templates

router = APIRouter()

VALID_DAYS: dict[str, int] = {"7d": 7, "30d": 30, "90d": 90, "365d": 365, "all": 3650}


@router.get("/informes", response_class=HTMLResponse)
async def informes_index(
    request: Request,
    user: CurrentUser,
    kpi: KpiDB,
    casa: str = Query("all"),
    period: str = Query("90d"),
) -> HTMLResponse:
    casa_filter: int | None = None
    if casa != "all":
        try:
            casa_filter = int(casa)
        except ValueError:
            casa = "all"

    if period not in VALID_DAYS:
        period = "90d"
    days = VALID_DAYS[period]

    informes = await queries.list_all_meta_analyses(
        kpi, casa_id=casa_filter, days=days, limit=200,
    )
    casas = await queries.list_casas(kpi)

    return templates.TemplateResponse(
        request,
        "informes.html",
        {
            "user": user,
            "informes": informes,
            "casas": casas,
            "active_casa": casa,
            "active_period": period,
            "period_options": list(VALID_DAYS.keys()),
        },
    )


@router.get("/informes/{informe_id}", response_class=HTMLResponse)
async def informe_detail(
    informe_id: int,
    request: Request,
    user: CurrentUser,
    kpi: KpiDB,
) -> HTMLResponse:
    informe = await queries.get_meta_analysis_by_id(kpi, informe_id)
    if not informe:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Informe no encontrado",
        )
    return templates.TemplateResponse(
        request,
        "informe_detail.html",
        {"user": user, "informe": informe},
    )
