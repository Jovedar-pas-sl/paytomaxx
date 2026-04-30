"""Settings page — minimal stub for v1 (shows links to Chatwoot)."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse
from app.deps import CurrentUser, SettingsDep
from app.template_env import templates

router = APIRouter()
@router.get("/settings", response_class=HTMLResponse)
async def settings_page(
    request: Request,
    user: CurrentUser,
    settings: SettingsDep,
) -> HTMLResponse:
    return templates.TemplateResponse(
        request,
        "settings.html",
        {
            "user": user,
            "admin_url": f"https://admin.{settings.domain}" if settings.domain else None,
            "admin_email": settings.kpi_admin_email,
            "domain": settings.domain or "(no configurado)",
        },
    )
