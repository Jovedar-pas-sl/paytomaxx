"""Ajustes — team / user management (super-admin only).

Routes (all require super_admin):
  GET  /ajustes                          — team page: users, casa assignment, audit feed
  POST /ajustes/users                     — create a user
  POST /ajustes/users/{uid}/toggle-active — activate / deactivate
  POST /ajustes/users/{uid}/role          — change role
  POST /ajustes/users/{uid}/password      — reset password
  POST /ajustes/users/{uid}/casas         — set casa assignment (agent scope)

Form-post + redirect-back-to-/ajustes (PRG) keeps it simple and robust. Every
mutation writes a lean audit_log entry.
"""
from __future__ import annotations

import json
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Form, Request, status
from fastapi.responses import HTMLResponse, RedirectResponse, Response

from app import queries, team
from app.auth import hash_password
from app.deps import KpiDB, RequireSuperAdmin
from app.template_env import templates

router = APIRouter()

_ROLES: set[str] = {"super_admin", "admin", "agent"}
_MIN_PASSWORD = 8

# Which meta keys to surface (in order) as the human-readable "· detalle" of an
# audit line. Keeps the feed readable ("Inició WhatsApp · vlc-334") without the
# template needing to know each action's meta shape.
_AUDIT_META_KEYS = ("label", "session", "name", "mode", "phone", "email", "new")


def _meta_detail(meta: Any) -> str:
    """Compact one-line detail from an audit row's meta. Tolerates asyncpg
    returning JSONB as either a dict or a raw JSON string, and never raises."""
    if not meta:
        return ""
    if isinstance(meta, str):
        try:
            meta = json.loads(meta)
        except (ValueError, TypeError):
            return ""
    if not isinstance(meta, dict):
        return ""
    parts = [str(meta[k]) for k in _AUDIT_META_KEYS if meta.get(k) not in (None, "")]
    return " · ".join(parts)


def _audit_view(row: Any) -> dict[str, Any]:
    """Shape an audit_log record for the Ajustes activity feed."""
    return {
        "at": row["at"],
        "actor_label": row["actor_label"],
        "action": row["action"],
        "entity_type": row["entity_type"],
        "entity_id": row["entity_id"],
        "detail": _meta_detail(row["meta"]),
    }


def _redirect(msg: str, *, ok: bool = True) -> RedirectResponse:
    key = "ok" if ok else "error"
    return RedirectResponse(url=f"/ajustes?{key}={quote(msg)}", status_code=status.HTTP_303_SEE_OTHER)


def _valid_email(email: str) -> bool:
    email = email.strip()
    return "@" in email and "." in email.split("@")[-1] and len(email) <= 254


@router.get("/ajustes", response_class=HTMLResponse)
async def ajustes_page(
    request: Request,
    user: RequireSuperAdmin,
    kpi: KpiDB,
) -> HTMLResponse:
    users = await team.list_users(kpi)
    assignments = await team.get_all_casa_assignments(kpi)
    casas = await queries.list_casas(kpi)
    audit = [_audit_view(r) for r in await team.list_recent_audit(kpi, limit=100)]
    return templates.TemplateResponse(
        request,
        "ajustes.html",
        {
            "user": user,
            "users": users,
            "assignments": assignments,
            "casas": casas,
            "audit": audit,
            "roles": ["super_admin", "admin", "agent"],
            "ok": request.query_params.get("ok"),
            "error": request.query_params.get("error"),
        },
    )


@router.post("/ajustes/users")
async def create_user(
    user: RequireSuperAdmin,
    kpi: KpiDB,
    name: str = Form(""),
    email: str = Form(...),
    password: str = Form(...),
    role: str = Form(...),
) -> Response:
    email = email.strip().lower()
    if not _valid_email(email):
        return _redirect("Email no válido", ok=False)
    if role not in _ROLES:
        return _redirect("Rol no válido", ok=False)
    if len(password) < _MIN_PASSWORD:
        return _redirect(f"La contraseña debe tener al menos {_MIN_PASSWORD} caracteres", ok=False)
    if await team.get_user_by_email(kpi, email) is not None:
        return _redirect("Ya existe un usuario con ese email", ok=False)

    created = await team.create_user(
        kpi,
        email=email,
        name=name,
        role=role,  # type: ignore[arg-type]  — validated above against _ROLES
        password_hash=hash_password(password),
    )
    await team.audit(
        kpi,
        action="user_create",
        actor_label=user.display_name,
        user_id=user.id,
        entity_type="user",
        entity_id=created.id,
        meta={"email": created.email, "role": created.role},
    )
    return _redirect(f"Usuario {created.email} creado")


@router.post("/ajustes/users/{uid}/toggle-active")
async def toggle_active(
    uid: int,
    user: RequireSuperAdmin,
    kpi: KpiDB,
) -> Response:
    if uid == user.id:
        return _redirect("No puedes desactivar tu propia cuenta", ok=False)
    target = await team.get_user_by_id(kpi, uid)
    if target is None:
        return _redirect("Usuario no encontrado", ok=False)
    new_active = not target.active
    await team.set_active(kpi, uid, new_active)
    await team.audit(
        kpi,
        action="user_active",
        actor_label=user.display_name,
        user_id=user.id,
        entity_type="user",
        entity_id=uid,
        meta={"email": target.email, "active": new_active},
    )
    return _redirect(f"{target.email} {'activado' if new_active else 'desactivado'}")


@router.post("/ajustes/users/{uid}/role")
async def change_role(
    uid: int,
    user: RequireSuperAdmin,
    kpi: KpiDB,
    role: str = Form(...),
) -> Response:
    if role not in _ROLES:
        return _redirect("Rol no válido", ok=False)
    if uid == user.id:
        return _redirect("No puedes cambiar tu propio rol", ok=False)
    target = await team.get_user_by_id(kpi, uid)
    if target is None:
        return _redirect("Usuario no encontrado", ok=False)
    await team.set_role(kpi, uid, role)  # type: ignore[arg-type]
    await team.audit(
        kpi,
        action="user_role",
        actor_label=user.display_name,
        user_id=user.id,
        entity_type="user",
        entity_id=uid,
        meta={"email": target.email, "role": role},
    )
    return _redirect(f"Rol de {target.email} cambiado a {role}")


@router.post("/ajustes/users/{uid}/password")
async def reset_password(
    uid: int,
    user: RequireSuperAdmin,
    kpi: KpiDB,
    password: str = Form(...),
) -> Response:
    if len(password) < _MIN_PASSWORD:
        return _redirect(f"La contraseña debe tener al menos {_MIN_PASSWORD} caracteres", ok=False)
    target = await team.get_user_by_id(kpi, uid)
    if target is None:
        return _redirect("Usuario no encontrado", ok=False)
    await team.set_password(kpi, uid, hash_password(password))
    await team.audit(
        kpi,
        action="user_password",
        actor_label=user.display_name,
        user_id=user.id,
        entity_type="user",
        entity_id=uid,
        meta={"email": target.email},
    )
    return _redirect(f"Contraseña de {target.email} actualizada")


@router.post("/ajustes/users/{uid}/casas")
async def set_casas(
    uid: int,
    user: RequireSuperAdmin,
    kpi: KpiDB,
    casa_ids: list[int] = Form(default=[]),
) -> Response:
    target = await team.get_user_by_id(kpi, uid)
    if target is None:
        return _redirect("Usuario no encontrado", ok=False)
    # Keep only real casa ids (defensive against tampered form input).
    # CasaSummary.account_id == casa.id (dataclass field name kept for template compat).
    valid_ids = {c.account_id for c in await queries.list_casas(kpi)}
    clean = [cid for cid in casa_ids if cid in valid_ids]
    await team.set_casa_assignments(kpi, uid, clean)
    await team.audit(
        kpi,
        action="user_casas",
        actor_label=user.display_name,
        user_id=user.id,
        entity_type="user",
        entity_id=uid,
        meta={"email": target.email, "casa_ids": clean},
    )
    scope = "todas las casas" if not clean else f"{len(clean)} casa(s)"
    return _redirect(f"Asignación de {target.email}: {scope}")
