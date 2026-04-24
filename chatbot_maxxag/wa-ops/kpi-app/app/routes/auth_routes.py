"""Login / logout routes."""

from __future__ import annotations

from fastapi import APIRouter, Form, Request, Response
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from app.auth import create_token, verify_password
from app.deps import Redis, SettingsDep

router = APIRouter()
templates = Jinja2Templates(directory="app/templates")

AUTH_COOKIE = "maxxag_kpi_auth"
AUTH_COOKIE_MAX_AGE = 60 * 60 * 24 * 30  # 30 days


@router.get("/login", response_class=HTMLResponse)
async def login_page(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(request, "login.html", {"error": None})


@router.post("/login", response_class=HTMLResponse)
async def login_submit(
    request: Request,
    settings: SettingsDep,
    redis: Redis,
    email: str = Form(...),
    password: str = Form(...),
) -> Response:
    # Rate limit by IP (simple counter with TTL)
    ip = request.client.host if request.client else "unknown"
    rate_key = f"login_fails:{ip}"
    fails = await redis.get(rate_key)
    if fails and int(fails) >= settings.login_rate_max_fails:
        window_min = max(1, settings.login_rate_window_seconds // 60)
        return templates.TemplateResponse(
            request,
            "login.html",
            {"error": f"Demasiados intentos. Espera {window_min} min."},
            status_code=429,
        )

    # Check credentials (normalize email — case + whitespace)
    normalized_email = email.strip().lower()
    expected_email = settings.kpi_admin_email.strip().lower()
    if normalized_email != expected_email or not verify_password(
        password, settings.kpi_admin_password_hash.get_secret_value()
    ):
        await redis.incr(rate_key)
        await redis.expire(rate_key, settings.login_rate_window_seconds)
        return templates.TemplateResponse(
            request,
            "login.html",
            {"error": "Credenciales incorrectas"},
            status_code=401,
        )

    # Success — clear rate limit, set cookie
    await redis.delete(rate_key)
    token = create_token(normalized_email)
    response = RedirectResponse(url="/", status_code=303)
    response.set_cookie(
        AUTH_COOKIE,
        token,
        max_age=AUTH_COOKIE_MAX_AGE,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
    )
    return response


@router.get("/logout")
async def logout(settings: SettingsDep) -> Response:
    response = RedirectResponse(url="/login", status_code=303)
    response.delete_cookie(AUTH_COOKIE, httponly=True, secure=settings.cookie_secure, samesite="lax")
    return response
