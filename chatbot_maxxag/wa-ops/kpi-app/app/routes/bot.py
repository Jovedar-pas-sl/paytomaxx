"""Bot (monitor) — vigilar a Sara: qué decide y cómo va, sin exponer el prompt.

Solo lectura (Slice 2D-a). Muestra, por conversación con Sara activa, su modo,
estado de pausa (y motivo por categoría), acción sugerida, intención y lo último
que dijo. Pausar / auto-protección se añaden en 2D-b.
"""
from __future__ import annotations

from fastapi import APIRouter, Request, status
from fastapi.responses import HTMLResponse, RedirectResponse, Response

from app import queries, team
from app.deps import KpiDB, RequireAdmin
from app.template_env import templates

router = APIRouter()


@router.get("/bot", response_class=HTMLResponse)
async def bot_monitor(
    request: Request,
    user: RequireAdmin,
    kpi: KpiDB,
) -> HTMLResponse:
    rows = await queries.list_bot_monitor(kpi, limit=40)
    paused_risk = sum(1 for r in rows if r.agent_status == "paused_risk")
    paused_human = sum(1 for r in rows if r.agent_status == "paused_human")
    active = sum(1 for r in rows if r.agent_status in (None, "active"))
    return templates.TemplateResponse(
        request,
        "bot.html",
        {
            "user": user,
            "rows": rows,
            "paused_risk": paused_risk,
            "paused_human": paused_human,
            "active": active,
        },
    )


@router.post("/bot/conversation/{conv_id}/pause")
async def pause_sara(conv_id: int, user: RequireAdmin, kpi: KpiDB) -> Response:
    """Pausar Sara en una conversación (la receptionist toma el relevo)."""
    await queries.set_conversation_agent_status(kpi, conv_id, "paused_human")
    await team.audit(
        kpi, action="sara_pause", actor_label=user.display_name, user_id=user.id,
        entity_type="conversation", entity_id=conv_id,
    )
    return RedirectResponse(url="/bot", status_code=status.HTTP_303_SEE_OTHER)


@router.post("/bot/conversation/{conv_id}/resume")
async def resume_sara(conv_id: int, user: RequireAdmin, kpi: KpiDB) -> Response:
    """Reanudar Sara: estado a activa + se reconoce la alerta de riesgo (si la hubo)."""
    await queries.set_conversation_agent_status(kpi, conv_id, "active")
    await queries.ack_risk_alerts(kpi, conv_id)
    await team.audit(
        kpi, action="sara_resume", actor_label=user.display_name, user_id=user.id,
        entity_type="conversation", entity_id=conv_id,
    )
    return RedirectResponse(url="/bot", status_code=status.HTTP_303_SEE_OTHER)
