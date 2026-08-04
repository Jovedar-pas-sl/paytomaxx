"""QR sharing — descarga PNG (admin) y enlace tokenizado (mamai-friendly).

Flujos:

  1. Admin (autenticado) en /sessions pulsa "Descargar QR":
       GET /sessions/<wa_id>/qr.png       → bytes PNG, attachment

  2. Admin pulsa "Compartir QR":
       POST /sessions/<wa_id>/share-qr    → genera token random, guarda en Redis
                                            con TTL=30min asociado al wa_number_id.
                                            Devuelve { url, expires_at }.

  3. Mamai abre el link en su móvil/PC:
       GET /qr/<token>                    → página fullscreen con QR + auto-refresh.
                                            Si la sesión pasa a WORKING, muestra
                                            "Conectado ✓" y borra el token.

       GET /qr/<token>/png                → bytes PNG en vivo (HTMX polling).

Seguridad:
  - El token es 32 chars random (urlsafe), TTL 30 min.
  - El QR de WhatsApp ya rota cada ~20 segundos (lo refresca WAHA).
  - Quien tenga el link puede vincular el número como dispositivo — por eso el
    link se genera bajo demanda y se invalida en cuanto empareja.
"""
from __future__ import annotations

import logging
import secrets
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import HTMLResponse, JSONResponse, Response
from app.deps import CurrentUser, KpiDB, Redis, Waha
from app.pairing import mark_pairing
from app.template_env import templates
from app.settings import get_settings

logger = logging.getLogger(__name__)
router = APIRouter()
QR_TOKEN_TTL_SECONDS = 30 * 60      # 30 min
QR_REDIS_PREFIX = "qr:share:"


# ── Admin: descarga PNG ───────────────────────────────────────────

@router.get("/sessions/{wa_id}/qr.png")
async def download_qr_png(
    wa_id: int,
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
    waha: Waha,
) -> Response:
    async with kpi.acquire() as conn:
        row = await conn.fetchrow("SELECT session, label FROM wa_number WHERE id = $1", wa_id)
    if not row:
        raise HTTPException(status_code=404, detail="WhatsApp no encontrado")

    png = await waha.get_qr_image_bytes(row["session"])
    if not png:
        raise HTTPException(
            status_code=409,
            detail="QR no disponible — la sesión no está en estado SCAN_QR_CODE",
        )

    fname = f"qr-{row['label']}-{row['session']}.png"
    safe = "".join(c if c.isalnum() or c in "-_." else "-" for c in fname)
    return Response(
        content=png,
        media_type="image/png",
        headers={
            "Content-Disposition": f'attachment; filename="{safe}"; filename*=UTF-8\'\'{quote(fname)}',
            "Cache-Control": "no-store",
        },
    )


# ── Admin: genera link compartible ───────────────────────────────

@router.post("/sessions/{wa_id}/share-qr")
async def create_qr_share_link(
    request: Request,
    wa_id: int,
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
    redis: Redis,
) -> JSONResponse:
    async with kpi.acquire() as conn:
        row = await conn.fetchrow("SELECT id, session, label FROM wa_number WHERE id = $1", wa_id)
    if not row:
        raise HTTPException(status_code=404, detail="WhatsApp no encontrado")

    token = secrets.token_urlsafe(24)
    key = f"{QR_REDIS_PREFIX}{token}"
    # value = wa_number_id; redis ttl handles expiry
    await redis.set(key, str(row["id"]), ex=QR_TOKEN_TTL_SECONDS)

    settings = get_settings()
    raw_domain = settings.domain or request.url.hostname or "localhost"
    domain = raw_domain.strip().rstrip("/")
    if "://" in domain:
        domain = domain.split("://", 1)[1]
    scheme = "https" if domain not in ("localhost", "127.0.0.1") else "http"
    base = f"{scheme}://kpi.{domain}" if "." in domain and not domain.startswith("kpi.") else f"{scheme}://{domain}"
    public_url = f"{base}/qr/{token}"
    expires_at = (datetime.now(timezone.utc) + timedelta(seconds=QR_TOKEN_TTL_SECONDS)).isoformat()

    # Note: we deliberately do NOT include the raw token in the response.
    # The token is already embedded in `url`; returning it twice would mean
    # any logger / monitoring capturing the response body would have a second
    # copy of the credential.
    return JSONResponse({
        "url": public_url,
        "expires_at": expires_at,
        "label": row["label"],
        "ttl_minutes": QR_TOKEN_TTL_SECONDS // 60,
    })


# ── Pública: página del QR (mamai abre en su móvil) ──────────────

async def _resolve_token(redis, token: str) -> int | None:
    """Returns wa_number_id if token valid, else None.

    The redis client is created with `decode_responses=True` (see deps.py)
    so `redis.get` returns `str | None`, never bytes.
    """
    v = await redis.get(f"{QR_REDIS_PREFIX}{token}")
    if v is None:
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


@router.get("/qr/{token}", response_class=HTMLResponse)
async def public_qr_page(
    request: Request,
    token: str,
    kpi: KpiDB,
    redis: Redis,
) -> HTMLResponse:
    wa_id = await _resolve_token(redis, token)
    if wa_id is None:
        return templates.TemplateResponse(
            request, "qr_share.html",
            {"expired": True, "label": None, "token": token},
            status_code=410,
        )
    async with kpi.acquire() as conn:
        row = await conn.fetchrow("SELECT label, session FROM wa_number WHERE id = $1", wa_id)
    if not row:
        return templates.TemplateResponse(
            request, "qr_share.html",
            {"expired": True, "label": None, "token": token},
            status_code=404,
        )
    # The mamai is opening the shared QR → mark the line as being paired so the
    # health-check leaves its SCAN_QR session up instead of stopping it mid-scan.
    await mark_pairing(redis, row["session"])
    return templates.TemplateResponse(
        request, "qr_share.html",
        {"expired": False, "label": row["label"], "token": token, "session": row["session"]},
    )


@router.get("/qr/{token}/png")
async def public_qr_png(
    token: str,
    kpi: KpiDB,
    redis: Redis,
    waha: Waha,
) -> Response:
    """Devuelve el PNG del QR para el polling. 410 si expira o ya emparejó."""
    wa_id = await _resolve_token(redis, token)
    if wa_id is None:
        return Response(status_code=410)

    async with kpi.acquire() as conn:
        row = await conn.fetchrow("SELECT session FROM wa_number WHERE id = $1", wa_id)
    if not row:
        return Response(status_code=404)

    # Actively-polled shared QR → keep the line protected from the churn-stop.
    await mark_pairing(redis, row["session"])

    # Check session status — if WORKING, invalidate token (paired successfully)
    try:
        sess = await waha.get_session(row["session"])
        if sess.get("status") == "WORKING":
            await redis.delete(f"{QR_REDIS_PREFIX}{token}")
            return Response(status_code=410, headers={"X-Status": "WORKING"})
    except Exception:
        # Si WAHA falla, seguimos intentando devolver el QR
        logger.exception("waha get_session failed in public_qr_png")

    # Wrap the QR fetch too — WAHA can 5xx during restarts, don't surface 500 to the public page
    try:
        png = await waha.get_qr_image_bytes(row["session"])
    except Exception:
        logger.exception("waha get_qr_image_bytes failed for token=%s", token[:8])
        return Response(status_code=503)

    if not png:
        return Response(status_code=409)

    return Response(
        content=png,
        media_type="image/png",
        headers={"Cache-Control": "no-store"},
    )


@router.get("/qr/{token}/status")
async def public_qr_status(
    token: str,
    kpi: KpiDB,
    redis: Redis,
    waha: Waha,
) -> JSONResponse:
    """Status JSON pequeñito para polling sin descargar el PNG cada vez."""
    wa_id = await _resolve_token(redis, token)
    if wa_id is None:
        return JSONResponse({"status": "EXPIRED"}, status_code=410)
    async with kpi.acquire() as conn:
        row = await conn.fetchrow("SELECT session FROM wa_number WHERE id = $1", wa_id)
    if not row:
        return JSONResponse({"status": "NOT_FOUND"}, status_code=404)
    # Actively-polled shared QR → keep the line protected from the churn-stop.
    await mark_pairing(redis, row["session"])
    try:
        sess = await waha.get_session(row["session"])
        status_str = sess.get("status", "UNKNOWN")
    except Exception:
        logger.warning("waha get_session failed in public_qr_status for token=%s", token[:8], exc_info=True)
        status_str = "UNKNOWN"
    if status_str == "WORKING":
        await redis.delete(f"{QR_REDIS_PREFIX}{token}")
    return JSONResponse({"status": status_str})
