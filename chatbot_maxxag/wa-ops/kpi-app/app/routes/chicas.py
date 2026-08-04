"""Sección "Chicas" — selector de casa → panel de gestión (Ficha del día).

Punto de entrada dedicado en el menú: eliges una casa y entras a su panel para
dar de alta / activar / gestionar las chicas disponibles. El panel en sí es la
Ficha del día (/casas/<id>/ficha), que se reutiliza. RBAC = admin.
"""
from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse

from app import queries
from app.deps import KpiDB, RequireAdmin
from app.template_env import templates

router = APIRouter()


@router.get("/chicas", response_class=HTMLResponse)
async def chicas_hub(
    request: Request, user: RequireAdmin, kpi: KpiDB
) -> HTMLResponse:
    casas = await queries.list_casas(kpi)
    counts = await queries.count_available_girls_by_casa(kpi)
    return templates.TemplateResponse(
        request,
        "chicas.html",
        {"user": user, "casas": casas, "counts": counts},
    )
