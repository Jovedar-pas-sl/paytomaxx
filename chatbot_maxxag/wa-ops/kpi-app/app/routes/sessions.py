"""WAHA session management panel — casa 1:N wa_number model."""

from __future__ import annotations

import asyncio
import logging
import re

from fastapi import APIRouter, Form, HTTPException, Request, status
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from app import queries, team
from app.deps import CurrentUser, KpiDB, Redis, Waha
from app.pairing import mark_pairing
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
    down_lines: list[dict] = []          # non-WORKING lines, for the "necesitan conexión" panel
    total_lines = 0
    working_lines = 0
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
            st = w_info.get("status") or "UNKNOWN"
            line = {**wn, "status": st, "engine": engine_val}
            wa_list.append(line)
            total_lines += 1
            if st == "WORKING":
                working_lines += 1
            else:
                down_lines.append({**line, "casa_id": c["id"], "casa_name": c["name"]})
        casa_working = sum(1 for w in wa_list if w["status"] == "WORKING")
        casas_view.append({
            "id": c["id"],
            "name": c["name"],
            "wa_numbers": wa_list,
            "working_count": casa_working,
            "total_count": len(wa_list),
        })

    summary = {
        "total": total_lines,
        "working": working_lines,
        "down": total_lines - working_lines,
        "down_lines": down_lines,
    }
    return templates.TemplateResponse(
        request, "sessions.html",
        {"user": user, "casas": casas_view, "summary": summary},
    )


# ── Casa CRUD ────────────────────────────────────────────────────
@router.post("/casas")
async def create_casa(
    user: CurrentUser,
    kpi: KpiDB,
    name: str = Form(...),
) -> RedirectResponse:
    name = name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Nombre requerido")
    async with kpi.acquire() as conn:
        casa_id = await conn.fetchval("INSERT INTO casa (name) VALUES ($1) RETURNING id", name)
    await team.audit(
        kpi, action="casa_create", actor_label=user.display_name, user_id=user.id,
        entity_type="casa", entity_id=casa_id, meta={"name": name},
    )
    return RedirectResponse(url="/sessions", status_code=status.HTTP_303_SEE_OTHER)


# ── WA number CRUD ───────────────────────────────────────────────
@router.post("/casas/{casa_id}/wa-numbers")
async def create_wa_number(
    casa_id: int,
    user: CurrentUser,
    kpi: KpiDB,
    redis: Redis,
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
            wa_id = await conn.fetchval(
                "INSERT INTO wa_number (casa_id, session, label) VALUES ($1, $2, $3) RETURNING id",
                casa_id, slug, label,
            )
        except Exception as exc:
            logger.exception("create wa_number failed")
            raise HTTPException(status_code=400, detail=f"No se pudo crear: {exc}") from exc

    # Try to create+start the WAHA session (multi-session is free since WAHA 2026.6.1).
    # Mark it as being paired so the health-check doesn't stop the brand-new
    # SCAN_QR session before the operator opens Conectar to scan it.
    await mark_pairing(redis, slug)
    try:
        await waha.create_session(slug, start=True)
    except Exception:
        logger.warning("WAHA create_session failed for %s", slug)

    await team.audit(
        kpi, action="wa_create", actor_label=user.display_name, user_id=user.id,
        entity_type="wa_number", entity_id=wa_id,
        meta={"label": label, "session": slug, "casa_id": casa_id},
    )
    return RedirectResponse(url="/sessions", status_code=status.HTTP_303_SEE_OTHER)


def _normalize_wa_phone(raw: str) -> str | None:
    """Keep digits only ('+34 621 033 316' → '34621033316'), matching the format the
    health-check worker stores (the WAHA session 'me' id) so format_phone renders it
    the same. Empty → None so the field can be cleared back to 'Sin teléfono'."""
    digits = "".join(ch for ch in (raw or "") if ch.isdigit())
    return digits or None


@router.post("/wa-numbers/{wa_id}/rename")
async def rename_wa_number(
    wa_id: int,
    user: CurrentUser,
    kpi: KpiDB,
    label: str = Form(...),
    phone: str = Form(""),
) -> RedirectResponse:
    """Edit a wa_number's label AND its phone. The phone is normally auto-detected by
    the health-check worker from the connected WAHA session ('me'), but some sessions
    (linked/clone lines) never report it — this lets the admin set it by hand so each
    line shows its number clearly. Blank clears it back to 'Sin teléfono'."""
    label = label.strip()
    if not label:
        raise HTTPException(status_code=400)
    normalized = _normalize_wa_phone(phone)
    async with kpi.acquire() as conn:
        await conn.execute(
            "UPDATE wa_number SET label = $1, phone = $2 WHERE id = $3",
            label, normalized, wa_id,
        )
    await team.audit(
        kpi, action="wa_edit", actor_label=user.display_name, user_id=user.id,
        entity_type="wa_number", entity_id=wa_id,
        meta={"label": label, "phone": normalized or ""},
    )
    return RedirectResponse(url="/sessions", status_code=status.HTTP_303_SEE_OTHER)


@router.post("/wa-numbers/{wa_id}/mode")
async def set_wa_number_mode(
    wa_id: int,
    user: CurrentUser,
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
    await team.audit(
        kpi, action="wa_mode", actor_label=user.display_name, user_id=user.id,
        entity_type="wa_number", entity_id=wa_id, meta={"mode": mode},
    )
    return RedirectResponse(url="/sessions", status_code=status.HTTP_303_SEE_OTHER)


@router.post("/wa-numbers/{wa_id}/delete")
async def delete_wa_number(
    wa_id: int,
    user: CurrentUser,
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
        await team.audit(
            kpi, action="wa_delete", actor_label=user.display_name, user_id=user.id,
            entity_type="wa_number", entity_id=wa_id, meta={"session": session},
        )
    return RedirectResponse(url="/sessions", status_code=status.HTTP_303_SEE_OTHER)


# ── Session control (by session slug, resolves to wa_number) ────
@router.get("/sessions/{name}/qr")
async def session_qr(
    name: str,
    user: CurrentUser,  # noqa: ARG001
    redis: Redis,
    waha: Waha,
) -> JSONResponse:
    # The Conectar modal polls this every ~2.5s while open → keep the "being
    # paired" flag fresh so the health-check leaves this SCAN_QR session running.
    await mark_pairing(redis, name)
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
async def session_start(name: str, user: CurrentUser, redis: Redis, waha: Waha) -> RedirectResponse:  # noqa: ARG001
    # Fired by the Conectar modal on open, so intentionally NOT audited — it would
    # flood the feed with a "wa_start" per QR view. Mark it as being paired so the
    # health-check leaves the SCAN_QR session up instead of stopping it.
    await mark_pairing(redis, name)
    try:
        await waha.start_session(name)
    except Exception:
        try:
            await waha.create_session(name, start=True)
        except Exception:
            logger.exception("start failed")
    return RedirectResponse(url="/sessions", status_code=status.HTTP_303_SEE_OTHER)


@router.post("/sessions/{name}/stop")
async def session_stop(name: str, user: CurrentUser, kpi: KpiDB, waha: Waha) -> RedirectResponse:
    ok = False
    try:
        await waha.stop_session(name)
        ok = True
    except Exception:
        logger.exception("stop failed")
    if ok:  # only record what actually happened
        await team.audit(
            kpi, action="wa_stop", actor_label=user.display_name, user_id=user.id,
            entity_type="wa_number", meta={"session": name},
        )
    return RedirectResponse(url="/sessions", status_code=status.HTTP_303_SEE_OTHER)


@router.post("/sessions/{name}/restart")
async def session_restart(name: str, user: CurrentUser, redis: Redis, waha: Waha) -> RedirectResponse:  # noqa: ARG001
    # Also fired by the modal ("Generar otro") → not audited (noise). Mark as
    # being paired so the health-check doesn't stop the fresh SCAN_QR session.
    await mark_pairing(redis, name)
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
async def session_logout(name: str, user: CurrentUser, kpi: KpiDB, waha: Waha) -> RedirectResponse:
    ok = False
    try:
        await waha.logout_session(name)
        ok = True
    except Exception:
        logger.exception("logout failed")
    if ok:  # only record a real disconnect
        await team.audit(
            kpi, action="wa_logout", actor_label=user.display_name, user_id=user.id,
            entity_type="wa_number", meta={"session": name},
        )
    return RedirectResponse(url="/sessions", status_code=status.HTTP_303_SEE_OTHER)


@router.post("/sessions/{name}/pairing-code")
async def session_pairing_code(
    name: str,
    user: CurrentUser,
    kpi: KpiDB,
    redis: Redis,
    waha: Waha,
    phone: str = Form(...),
) -> JSONResponse:
    """Return an 8-char pairing code ('ABCD-ABCD') for `name` so the owner can link
    by TYPING it into WhatsApp (no QR scan, single phone). The Conectar modal
    starts the session first; here we only ask WAHA for the code.

    409 when WAHA can't issue one (NOWEB pairing-code is not always available) —
    the UI then keeps the QR, which is the mandatory fallback."""
    # Requesting a code is an explicit pairing action → keep the line protected.
    await mark_pairing(redis, name)
    digits = _normalize_wa_phone(phone)
    if not digits:
        return JSONResponse({"error": "phone_required"}, status_code=400)
    code = await waha.request_pairing_code(name, digits)
    if not code:
        return JSONResponse({"error": "unavailable"}, status_code=409)
    await team.audit(
        kpi, action="wa_pairing_code", actor_label=user.display_name, user_id=user.id,
        entity_type="wa_number", meta={"session": name},
    )
    return JSONResponse({"code": code})
