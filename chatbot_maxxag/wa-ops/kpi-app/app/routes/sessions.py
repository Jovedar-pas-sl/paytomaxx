"""WAHA session management panel — casa 1:N wa_number model."""

from __future__ import annotations

import asyncio
import logging
import re

from fastapi import APIRouter, Form, HTTPException, Request, status
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from app import queries
from app.deps import CurrentUser, KpiDB, Waha
from app.template_env import templates

logger = logging.getLogger(__name__)
router = APIRouter()
SLUG_RE = re.compile(r"^[a-z0-9-]+$")
# Allowed agent modes for a wa_number (mirrors the DB CHECK in migration 0014).
_VALID_AGENT_MODES = {"off", "auto", "copilot"}


def _slugify(s: str) -> str:
    out = re.sub(r"[^a-z0-9-]+", "-", s.strip().lower()).strip("-")
    return out[:40] or "wa"


@router.get("/sessions", response_class=HTMLResponse)
async def sessions_panel(
    request: Request,
    user: CurrentUser,
    kpi: KpiDB,
    waha: Waha,
) -> HTMLResponse:
    try:
        waha_sessions = await waha.list_sessions(include_stopped=True)
    except Exception:
        logger.exception("cannot reach WAHA")
        waha_sessions = []
    waha_by_session: dict[str, dict] = {
        s.get("name"): s for s in waha_sessions if s.get("name")
    }

    async with kpi.acquire() as conn:
        casas = await conn.fetch(
            """
            SELECT c.id, c.name,
                   coalesce(
                     json_agg(json_build_object(
                       'id', w.id, 'session', w.session, 'label', w.label,
                       'phone', w.phone, 'mode', w.mode
                     ) ORDER BY w.created_at)
                     FILTER (WHERE w.id IS NOT NULL),
                     '[]'::json
                   ) AS wa_numbers
            FROM casa c
            LEFT JOIN wa_number w ON w.casa_id = c.id
            GROUP BY c.id, c.name
            ORDER BY c.name
            """
        )

    casas_view: list[dict] = []
    for c in casas:
        wa_list = []
        import json as _json
        nums = c["wa_numbers"]
        if isinstance(nums, str):
            nums = _json.loads(nums)
        for wn in nums or []:
            w_info = waha_by_session.get(wn["session"]) or {}
            engine_val = w_info.get("engine")
            if isinstance(engine_val, dict):
                engine_val = engine_val.get("engine")
            wa_list.append({
                **wn,
                "status": w_info.get("status") or "UNKNOWN",
                "engine": engine_val,
            })
        casas_view.append({
            "id": c["id"],
            "name": c["name"],
            "wa_numbers": wa_list,
        })

    return templates.TemplateResponse(
        request, "sessions.html",
        {"user": user, "casas": casas_view},
    )


# ── Casa CRUD ────────────────────────────────────────────────────
@router.post("/casas")
async def create_casa(
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
    name: str = Form(...),
) -> RedirectResponse:
    name = name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Nombre requerido")
    async with kpi.acquire() as conn:
        await conn.execute("INSERT INTO casa (name) VALUES ($1)", name)
    return RedirectResponse(url="/sessions", status_code=status.HTTP_303_SEE_OTHER)


# ── WA number CRUD ───────────────────────────────────────────────
@router.post("/casas/{casa_id}/wa-numbers")
async def create_wa_number(
    casa_id: int,
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
    waha: Waha,
    label: str = Form(...),
    session: str = Form(""),
) -> RedirectResponse:
    label = label.strip()
    if not label:
        raise HTTPException(status_code=400, detail="Etiqueta requerida")

    slug = _slugify(session) if session else _slugify(label)
    if not SLUG_RE.match(slug):
        raise HTTPException(status_code=400, detail="Slug inválido (usa a-z, 0-9, -)")

    async with kpi.acquire() as conn:
        try:
            await conn.execute(
                "INSERT INTO wa_number (casa_id, session, label) VALUES ($1, $2, $3)",
                casa_id, slug, label,
            )
        except Exception as exc:
            logger.exception("create wa_number failed")
            raise HTTPException(status_code=400, detail=f"No se pudo crear: {exc}") from exc

    # Try to create+start the WAHA session. Free tier limits to "default" only.
    try:
        await waha.create_session(slug, start=True)
    except Exception:
        logger.warning("WAHA create_session failed for %s (likely free tier limit)", slug)

    return RedirectResponse(url="/sessions", status_code=status.HTTP_303_SEE_OTHER)


@router.post("/wa-numbers/{wa_id}/rename")
async def rename_wa_number(
    wa_id: int,
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
    label: str = Form(...),
) -> RedirectResponse:
    label = label.strip()
    if not label:
        raise HTTPException(status_code=400)
    async with kpi.acquire() as conn:
        await conn.execute("UPDATE wa_number SET label = $1 WHERE id = $2", label, wa_id)
    return RedirectResponse(url="/sessions", status_code=status.HTTP_303_SEE_OTHER)


@router.post("/wa-numbers/{wa_id}/mode")
async def set_wa_number_mode(
    wa_id: int,
    user: CurrentUser,  # noqa: ARG001 — auth gate
    kpi: KpiDB,
    mode: str = Form(...),
) -> RedirectResponse:
    """Set a wa_number's agent mode (off|auto|copilot).

    Default is 'off' (set at the DB level) so the agent is inert until a number
    is explicitly enabled here. Validated at the boundary; the DB CHECK is the
    last line of defense. Callable now via:
        curl -X POST .../wa-numbers/<id>/mode -d mode=auto  (with auth cookie)
    """
    mode = mode.strip().lower()
    if mode not in _VALID_AGENT_MODES:
        raise HTTPException(status_code=400, detail="Modo inválido (off|auto|copilot)")
    await queries.set_wa_mode(kpi, wa_id, mode)
    return RedirectResponse(url="/sessions", status_code=status.HTTP_303_SEE_OTHER)


@router.post("/wa-numbers/{wa_id}/delete")
async def delete_wa_number(
    wa_id: int,
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
    waha: Waha,
) -> RedirectResponse:
    async with kpi.acquire() as conn:
        session = await conn.fetchval("SELECT session FROM wa_number WHERE id = $1", wa_id)
        if session:
            await conn.execute("DELETE FROM wa_number WHERE id = $1", wa_id)
    if session:
        try:
            await waha.logout_session(session)
        except Exception:
            pass
        try:
            # WAHA doesn't always have a delete-session endpoint; stop is best effort
            await waha.stop_session(session)
        except Exception:
            pass
    return RedirectResponse(url="/sessions", status_code=status.HTTP_303_SEE_OTHER)


# ── Session control (by session slug, resolves to wa_number) ────
@router.get("/sessions/{name}/qr")
async def session_qr(
    name: str,
    user: CurrentUser,  # noqa: ARG001
    waha: Waha,
) -> JSONResponse:
    try:
        info = await waha.get_session(name)
    except Exception:
        return JSONResponse({"status": "error"}, status_code=502)

    current = info.get("status")
    if current == "WORKING":
        me = info.get("me") or {}
        return JSONResponse({"status": "WORKING", "me": me.get("id") or me.get("pushName", "")})
    if current != "SCAN_QR_CODE":
        return JSONResponse({"status": current, "qr": None})

    qr = await waha.get_qr(name)
    return JSONResponse({"status": current, "qr": qr})


@router.post("/sessions/{name}/start")
async def session_start(name: str, user: CurrentUser, waha: Waha) -> RedirectResponse:  # noqa: ARG001
    try:
        await waha.start_session(name)
    except Exception:
        try:
            await waha.create_session(name, start=True)
        except Exception:
            logger.exception("start failed")
    return RedirectResponse(url="/sessions", status_code=status.HTTP_303_SEE_OTHER)


@router.post("/sessions/{name}/stop")
async def session_stop(name: str, user: CurrentUser, waha: Waha) -> RedirectResponse:  # noqa: ARG001
    try:
        await waha.stop_session(name)
    except Exception:
        logger.exception("stop failed")
    return RedirectResponse(url="/sessions", status_code=status.HTTP_303_SEE_OTHER)


@router.post("/sessions/{name}/restart")
async def session_restart(name: str, user: CurrentUser, waha: Waha) -> RedirectResponse:  # noqa: ARG001
    try:
        await waha.stop_session(name)
    except Exception:
        pass
    await asyncio.sleep(2)
    try:
        await waha.start_session(name)
    except Exception:
        logger.exception("restart: start step failed")
    return RedirectResponse(url="/sessions", status_code=status.HTTP_303_SEE_OTHER)


@router.post("/sessions/{name}/logout")
async def session_logout(name: str, user: CurrentUser, waha: Waha) -> RedirectResponse:  # noqa: ARG001
    try:
        await waha.logout_session(name)
    except Exception:
        logger.exception("logout failed")
    return RedirectResponse(url="/sessions", status_code=status.HTTP_303_SEE_OTHER)
