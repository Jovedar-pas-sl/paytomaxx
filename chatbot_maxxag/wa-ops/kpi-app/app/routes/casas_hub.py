"""Casas selector — entry point to workspaces.

Route: GET /casas
Renders a list of houses with their current state; each card enters the
workspace for that casa.
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse
from app import queries
from app.deps import CurrentUser, KpiDB
from app.template_env import templates

router = APIRouter()
@router.get("/casas", response_class=HTMLResponse)
async def casas_list(
    request: Request,
    user: CurrentUser,
    kpi: KpiDB,
) -> HTMLResponse:
    casas = await queries.list_casas(kpi)
    return templates.TemplateResponse(
        request,
        "casas_select.html",
        {"user": user, "casas": casas},
    )
