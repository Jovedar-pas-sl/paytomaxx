"""Ajustes · Entrenamiento — review the style examples Sara learns from.

The daily harvest cron (harvest_style_examples_job) collects real human-
receptionist replies per casa as status='pending'. Here a super-admin approves
or rejects them; APPROVED ones are injected into Sara's system prompt as style
guidance (see reply_engine._build_style_block).

Routes (all require super_admin):
  GET  /ajustes/estilo                 — pending candidates (grouped by casa) + counts
  POST /ajustes/estilo/{eid}/approve   — approve one candidate
  POST /ajustes/estilo/{eid}/reject    — reject one candidate

Form-post + redirect-back (PRG), mirroring settings_routes.
"""
from __future__ import annotations

import logging
from urllib.parse import quote

from fastapi import APIRouter, Form, Request, status
from fastapi.responses import HTMLResponse, RedirectResponse, Response

from app import queries, team
from app.agent import style_harvest
from app.deps import KpiDB, RequireSuperAdmin
from app.template_env import templates

logger = logging.getLogger(__name__)
router = APIRouter()

_VALID_STATUS = {"approved": "aprobado", "rejected": "rechazado"}


def _redirect(msg: str, *, ok: bool = True) -> RedirectResponse:
    key = "ok" if ok else "error"
    return RedirectResponse(
        url=f"/ajustes/estilo?{key}={quote(msg)}", status_code=status.HTTP_303_SEE_OTHER
    )


@router.get("/ajustes/estilo", response_class=HTMLResponse)
async def estilo_page(
    request: Request,
    user: RequireSuperAdmin,
    kpi: KpiDB,
) -> HTMLResponse:
    pending = await queries.list_style_examples(kpi, status="pending", limit=300)
    counts = await queries.count_style_examples(kpi)
    ab_stats = await queries.ab_greeting_stats(kpi)
    return templates.TemplateResponse(
        request,
        "estilo.html",
        {
            "user": user,
            "pending": pending,
            "counts": counts,
            "ab_stats": ab_stats,
            "ok": request.query_params.get("ok"),
            "error": request.query_params.get("error"),
        },
    )


@router.post("/ajustes/estilo/refresh")
async def refresh_examples(
    user: RequireSuperAdmin,
    kpi: KpiDB,
) -> Response:
    """On-demand harvest: collect NEW human-receptionist replies into pending
    candidates RIGHT NOW, instead of waiting for the daily 04:30 cron. Same
    function the cron uses (style_harvest.harvest_casa) — pure read+insert (no
    LLM, no sends), fault-isolated per casa, so it's safe to run inline in the
    request. New candidates appear immediately in the list below on redirect."""
    try:
        casas = await queries.list_casas(kpi)
    except Exception:
        logger.exception("estilo refresh: list_casas failed")
        return _redirect("No se pudieron cargar las casas", ok=False)
    total = 0
    for casa in casas:
        try:
            total += await style_harvest.harvest_casa(kpi, casa.account_id)
        except Exception:
            logger.exception("estilo refresh: harvest failed casa=%s", casa.account_id)
    await team.audit(
        kpi, action="style_refresh", actor_label=user.display_name, user_id=user.id,
        meta={"new": total},
    )
    if total:
        return _redirect(f"{total} respuestas nuevas para revisar 👇")
    return _redirect("Sin respuestas nuevas — ya estaban todas revisadas")


async def _decide(kpi: KpiDB, eid: int, new_status: str) -> Response:
    if new_status not in _VALID_STATUS:
        return _redirect("Acción no válida", ok=False)
    updated = await queries.set_style_example_status(kpi, eid, new_status)
    if not updated:
        return _redirect("Ejemplo no encontrado", ok=False)
    return _redirect(f"Ejemplo {_VALID_STATUS[new_status]}")


@router.post("/ajustes/estilo/{eid}/approve")
async def approve_example(
    eid: int,
    user: RequireSuperAdmin,
    kpi: KpiDB,
) -> Response:
    resp = await _decide(kpi, eid, "approved")
    await team.audit(
        kpi, action="style_approve", actor_label=user.display_name, user_id=user.id,
        entity_type="style_example", entity_id=eid,
    )
    return resp


@router.post("/ajustes/estilo/{eid}/reject")
async def reject_example(
    eid: int,
    user: RequireSuperAdmin,
    kpi: KpiDB,
) -> Response:
    resp = await _decide(kpi, eid, "rejected")
    await team.audit(
        kpi, action="style_reject", actor_label=user.display_name, user_id=user.id,
        entity_type="style_example", entity_id=eid,
    )
    return resp
