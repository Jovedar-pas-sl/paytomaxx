"""FastAPI application entrypoint."""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from app.deps import CurrentUser, lifespan
from app.logging_config import configure_logging, new_request_id, request_id_var
from app.template_env import templates
from app.routes.admin import router as admin_router
from app.routes.alerts import router as alerts_router
from app.routes.analysis_ops import router as analysis_ops_router
from app.routes.bot import router as bot_router
from app.routes.auth_routes import router as auth_router
from app.routes.casa_workspace import router as casa_workspace_router
from app.routes.casas_hub import router as casas_hub_router
from app.routes.conversation import router as conversation_router
from app.routes.chicas import router as chicas_router
from app.routes.exports import router as exports_router
from app.routes.ficha import router as ficha_router
from app.routes.health import router as health_router
from app.routes.informes import router as informes_router
from app.routes.media import router as media_router
from app.routes.metricas import router as metricas_router
from app.routes.qr_share import router as qr_share_router
from app.routes.sessions import router as sessions_router
from app.routes.settings_routes import router as settings_router
from app.routes.style_routes import router as style_router
from app.routes.webhooks import router as webhooks_router
from app.routes.widgets import router as widgets_router

configure_logging()

app = FastAPI(
    title="Maxxag WA Ops — KPI Dashboard",
    lifespan=lifespan,
)


# ── Request ID middleware (must run BEFORE any other middleware) ──
# Generates a per-request correlation ID and attaches it as a contextvar
# so every log emitted during the request lifecycle includes it. Also
# echoes it back in `X-Request-ID` so the operator can reference one
# specific request when debugging.
@app.middleware("http")
async def request_id_middleware(request, call_next):
    rid = request.headers.get("x-request-id") or new_request_id()
    token = request_id_var.set(rid)
    try:
        response = await call_next(request)
        response.headers["X-Request-ID"] = rid
        return response
    finally:
        request_id_var.reset(token)


# ── CSRF protection (Origin/Referer header check) ─────────────────
# Stateless protection: any state-changing request (POST/PUT/PATCH/DELETE)
# must come from a trusted origin (the host the user is on, or 'null' for
# webhooks which authenticate via HMAC). This blocks classic CSRF where an
# attacker site tries to POST on behalf of a logged-in user.
@app.middleware("http")
async def csrf_origin_check(request, call_next):
    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        # Webhooks are authenticated by HMAC, not by browser cookies → exempt.
        path = request.url.path
        if not path.startswith("/webhook/"):
            origin = request.headers.get("origin")
            referer = request.headers.get("referer")
            host = request.headers.get("host", "")
            expected = {f"https://{host}", f"http://{host}"}
            ok = False
            if origin and origin in expected:
                ok = True
            elif referer:
                # Referer is a full URL — check it starts with one of expected
                ok = any(referer.startswith(e + "/") or referer == e for e in expected)
            if not ok:
                from fastapi.responses import JSONResponse
                return JSONResponse(
                    status_code=403,
                    content={"detail": "CSRF: Origin/Referer mismatch"},
                )
    return await call_next(request)


# ── Security headers (defense in depth) ───────────────────────────
# A panel with client PII + one-click WhatsApp send must not be framable
# (clickjacking) and should send conservative headers. No CSP here on purpose:
# the templates use inline Tailwind config + CDN scripts (jsDelivr), so a strict
# CSP would break the UI — tracked as a follow-up.
_SECURITY_HEADERS = {
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
}


@app.middleware("http")
async def security_headers(request, call_next):
    response = await call_next(request)
    for key, value in _SECURITY_HEADERS.items():
        response.headers.setdefault(key, value)
    return response


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
app.include_router(analysis_ops_router)    # /casas/<id>/block-analysis + /meta-analyses/{progress,latest-state}
app.include_router(exports_router)         # /casas/<id>/export/* + /conversation/<id>/export.txt
app.include_router(media_router)           # /media/<msg_id> — proxy for WAHA attachments
app.include_router(qr_share_router)        # /sessions/<id>/qr.png + /qr/<token> public share
app.include_router(informes_router)        # /informes + /informes/<id> — global meta-analysis archive
app.include_router(admin_router)           # /admin/costs — Claude API spending dashboard
app.include_router(settings_router)        # /ajustes — super-admin team management
app.include_router(style_router)           # /ajustes/estilo — Sara style-example review
app.include_router(bot_router)             # /bot — monitor de Sara (admin)
app.include_router(metricas_router)        # /metricas — KPIs pro marketing + locales (admin)
app.include_router(ficha_router)           # /casas/<id>/ficha — panel disponibilidad/precios (admin)
app.include_router(chicas_router)          # /chicas — selector de casa → panel de chicas (admin)


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
