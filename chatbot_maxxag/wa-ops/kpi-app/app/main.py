"""FastAPI application entrypoint."""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from app.deps import CurrentUser, lifespan
from app.template_env import templates
from app.routes.alerts import router as alerts_router
from app.routes.analysis_ops import router as analysis_ops_router
from app.routes.auth_routes import router as auth_router
from app.routes.casa_workspace import router as casa_workspace_router
from app.routes.casas_hub import router as casas_hub_router
from app.routes.conversation import router as conversation_router
from app.routes.exports import router as exports_router
from app.routes.health import router as health_router
from app.routes.informes import router as informes_router
from app.routes.media import router as media_router
from app.routes.qr_share import router as qr_share_router
from app.routes.sessions import router as sessions_router
from app.routes.webhooks import router as webhooks_router
from app.routes.widgets import router as widgets_router

app = FastAPI(
    title="Maxxag WA Ops — KPI Dashboard",
    lifespan=lifespan,
)

app.mount("/static", StaticFiles(directory="app/static"), name="static")
# ── Routers ────────────────────────────────────────────────────────
app.include_router(health_router)          # /health — public
app.include_router(auth_router)            # /login, /logout — public
app.include_router(webhooks_router)        # /webhook/*  — internal network only
app.include_router(widgets_router)         # /widget/*   — auth required
app.include_router(casas_hub_router)       # /casas — selector
app.include_router(casa_workspace_router)  # /casas/<id> — workspace with tabs
app.include_router(conversation_router)    # /conversation/<id>
app.include_router(alerts_router)          # /alerts
app.include_router(sessions_router)        # /sessions — WAHA management
app.include_router(analysis_ops_router)    # /casas/<id>/meta-analyses + /analyze-pending + /conversation/<id>/analyze
app.include_router(exports_router)         # /casas/<id>/export/* + /conversation/<id>/export.txt
app.include_router(media_router)           # /media/<msg_id> — proxy for WAHA attachments
app.include_router(qr_share_router)        # /sessions/<id>/qr.png + /qr/<token> public share
app.include_router(informes_router)        # /informes + /informes/<id> — global meta-analysis archive


# ── Legacy redirects ───────────────────────────────────────────────
from fastapi.responses import RedirectResponse


@app.get("/casa/{casa_id}")
async def legacy_casa_redirect(casa_id: int) -> RedirectResponse:
    return RedirectResponse(url=f"/casas/{casa_id}", status_code=301)


@app.get("/conversations")
async def legacy_conversations_redirect() -> RedirectResponse:
    return RedirectResponse(url="/casas", status_code=302)


# ── Home ───────────────────────────────────────────────────────────
@app.get("/", response_class=HTMLResponse)
async def home(request: Request, user: CurrentUser) -> HTMLResponse:
    return templates.TemplateResponse(request, "dashboard.html", {"user": user})


# ── 401 redirect ───────────────────────────────────────────────────
@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException) -> HTMLResponse | RedirectResponse:
    # Only redirect on auth failures for HTML requests
    if exc.status_code == 401:
        accept = request.headers.get("accept", "")
        # HTMX and HTML requests → redirect; API/JSON → surface the 401
        if "text/html" in accept or request.headers.get("hx-request"):
            return RedirectResponse(url="/login", status_code=303)
    # Default 4xx/5xx rendering
    return templates.TemplateResponse(
        request,
        "error.html",
        {"status": exc.status_code, "detail": exc.detail},
        status_code=exc.status_code,
    )
