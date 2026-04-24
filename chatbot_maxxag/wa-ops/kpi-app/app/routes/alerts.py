"""Alerts page + ack endpoint."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import HTMLResponse, Response
from fastapi.templating import Jinja2Templates

from app.deps import CurrentUser, KpiDB

router = APIRouter()
templates = Jinja2Templates(directory="app/templates")


@router.get("/alerts", response_class=HTMLResponse)
async def alerts_page(
    request: Request,
    user: CurrentUser,
    kpi: KpiDB,
    show: str = "active",
) -> HTMLResponse:
    where = "WHERE acknowledged_at IS NULL" if show == "active" else ""
    async with kpi.acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT id, type, severity, conversation_id, inbox_id, message,
                   created_at, acknowledged_at
            FROM alert
            {where}
            ORDER BY (acknowledged_at IS NULL) DESC, created_at DESC
            LIMIT 200
            """
        )
        counts = await conn.fetchrow(
            """
            SELECT
              count(*) FILTER (WHERE acknowledged_at IS NULL)  AS active,
              count(*)                                         AS total
            FROM alert
            """
        )
    return templates.TemplateResponse(
        request,
        "alerts.html",
        {
            "user": user,
            "alerts": [dict(r) for r in rows],
            "show": show,
            "active_count": counts["active"],
            "total_count": counts["total"],
        },
    )


@router.post("/alerts/{alert_id}/ack")
async def ack_alert(
    alert_id: int,
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
) -> Response:
    async with kpi.acquire() as conn:
        result = await conn.execute(
            "UPDATE alert SET acknowledged_at = now() WHERE id = $1 AND acknowledged_at IS NULL",
            alert_id,
        )
    if not result.endswith(" 1"):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Alerta no encontrada")
    return Response(status_code=204)


@router.post("/alerts/ack-all")
async def ack_all_alerts(
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
) -> Response:
    """Mark all active alerts as acknowledged. Used by the 'Silenciar todas' button."""
    async with kpi.acquire() as conn:
        await conn.execute(
            "UPDATE alert SET acknowledged_at = now() WHERE acknowledged_at IS NULL"
        )
    return Response(status_code=204, headers={"HX-Refresh": "true"})
