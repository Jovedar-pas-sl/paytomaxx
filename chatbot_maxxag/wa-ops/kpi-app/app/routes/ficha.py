"""Ficha del día — panel operativo por casa.

El OPERADOR controla, por casa: qué chicas están disponibles hoy, su horario, los
servicios, si Sara envía su foto, el orden, y los precios del "plus". Estos campos
son la FUENTE DE VERDAD: el sync de la web no los pisa (ver los upserts en
queries.py). La importación desde la web es un botón (no un cron): encola
`website_sync_job`, que SOLO añade chicas nuevas y refresca fotos.

Todo escribe con scope por casa_id; RBAC = admin o super_admin.
"""
from __future__ import annotations

from urllib.parse import urlencode

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import HTMLResponse, RedirectResponse, Response

from app import girl_media, queries, team
from app.deps import Arq, KpiDB, RequireAdmin
from app.template_env import templates

router = APIRouter()

# Límites defensivos del formulario de precios (admin-only; defensa en profundidad).
_MAX_RATES = 30
_MAX_FIELD_LEN = 120


async def _casa_name_or_404(kpi: KpiDB, casa_id: int) -> str:
    async with kpi.acquire() as conn:
        row = await conn.fetchrow("SELECT name FROM casa WHERE id = $1", casa_id)
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Casa no encontrada")
    return row["name"]


def _redirect(casa_id: int, ok: str | None = None) -> RedirectResponse:
    url = f"/casas/{casa_id}/ficha"
    if ok:
        url += "?" + urlencode({"ok": ok})
    return RedirectResponse(url=url, status_code=status.HTTP_303_SEE_OTHER)


def _parse_age(raw) -> int | None:
    """Edad del form → int en rango sensato (18–99) o None."""
    s = str(raw or "").strip()
    if not s:
        return None
    try:
        age = int(s)
    except ValueError:
        return None
    return age if 18 <= age <= 99 else None


async def _maybe_save_photo(kpi: KpiDB, casa_id: int, girl_id: int, photo) -> None:
    """Si se subió una foto válida, la persiste y la asigna a la chica. Fail-soft:
    una foto inválida/ausente no cambia nada."""
    if photo is None or not getattr(photo, "filename", None):
        return
    url = await girl_media.save_girl_photo(photo)
    if url:
        await queries.set_girl_photo(kpi, casa_id, girl_id, url)


# ── Panel ────────────────────────────────────────────────────────────
@router.get("/casas/{casa_id}/ficha", response_class=HTMLResponse)
async def ficha_panel(
    casa_id: int,
    request: Request,
    user: RequireAdmin,
    kpi: KpiDB,
    ok: str = Query(""),
) -> HTMLResponse:
    casa_name = await _casa_name_or_404(kpi, casa_id)
    girls = await queries.list_girls_for_panel(kpi, casa_id)
    knowledge = await queries.get_casa_knowledge(kpi, casa_id)
    rates_items = []
    manual_mode = False
    if knowledge.profile:
        manual_mode = knowledge.profile.manual_mode
        if isinstance(knowledge.profile.rates, dict):
            rates_items = [r for r in knowledge.profile.rates.get("items", []) if isinstance(r, dict)]
    return templates.TemplateResponse(
        request,
        "ficha.html",
        {
            "user": user,
            "casa_id": casa_id,
            "casa_name": casa_name,
            "manual_mode": manual_mode,
            "girls": girls,
            "rates_items": rates_items,
            "available_count": sum(1 for g in girls if g.available_today),
            "ok": ok,
        },
    )


# ── Toggle maestro: Web sync ⇄ Backoffice (manual) ───────────────────
@router.post("/casas/{casa_id}/mode")
async def toggle_mode(
    casa_id: int, request: Request, user: RequireAdmin, kpi: KpiDB
) -> Response:
    """Conmuta el modo de la casa. manual=on → Backoffice (el panel manda, el sync
    automático salta esta casa). manual ausente → Web sync (la web manda)."""
    await _casa_name_or_404(kpi, casa_id)
    form = await request.form()
    on = form.get("manual") == "on"
    await queries.set_casa_manual_mode(kpi, casa_id, on)
    await team.audit(
        kpi, action="casa_mode", actor_label=user.display_name, user_id=user.id,
        entity_type="casa", entity_id=casa_id,
    )
    return _redirect(casa_id, ok="modo")


# ── Guardar una chica (disponibilidad + foto + horario + servicios + orden) ──
@router.post("/casas/{casa_id}/girls/{girl_id}")
async def save_girl(
    casa_id: int, girl_id: int, request: Request, user: RequireAdmin, kpi: KpiDB
) -> Response:
    form = await request.form()
    available = form.get("available") == "on"
    send_photo = form.get("send_photo") == "on"
    hours = str(form.get("hours_today") or "")
    # Servicios: una por línea o separados por coma.
    raw_services = str(form.get("services") or "")
    services = [s.strip() for s in raw_services.replace("\n", ",").split(",") if s.strip()]
    try:
        sort_order = int(str(form.get("sort_order") or "0").strip() or "0")
    except ValueError:
        sort_order = 0
    sort_order = max(0, min(sort_order, 9999))  # clamp: evita valores absurdos

    await queries.set_girl_available(kpi, casa_id, girl_id, available)
    await queries.set_girl_send_photo(kpi, casa_id, girl_id, send_photo)
    await queries.update_girl_details(
        kpi, casa_id, girl_id,
        hours_today=hours, services=services, sort_order=sort_order,
    )
    # Alta MANUAL (ext_id NULL): nombre/edad/nacionalidad editables + re-subir foto.
    # Estos campos solo llegan en las tarjetas de chicas manuales; para las de la
    # web no vienen en el form → no se tocan.
    name = str(form.get("name") or "").strip()
    if name:
        await queries.update_girl_profile(
            kpi, casa_id, girl_id,
            name=name, age=_parse_age(form.get("age")),
            nationality=str(form.get("nationality") or ""),
        )
    await _maybe_save_photo(kpi, casa_id, girl_id, form.get("photo"))
    return _redirect(casa_id, ok="chica")


# ── Alta manual de una chica (con foto) ──────────────────────────────
@router.post("/casas/{casa_id}/girls/add")
async def add_girl(
    casa_id: int, request: Request, user: RequireAdmin, kpi: KpiDB
) -> Response:
    """Crea una chica MANUAL (ext_id NULL → el sync web nunca la toca). Nombre
    obligatorio; el resto opcional. La foto se valida (magic bytes) y guarda."""
    await _casa_name_or_404(kpi, casa_id)
    form = await request.form()
    name = str(form.get("name") or "").strip()
    if not name:
        return _redirect(casa_id, ok="chica")  # sin nombre no se crea
    raw_services = str(form.get("services") or "")
    services = [s.strip() for s in raw_services.replace("\n", ",").split(",") if s.strip()]
    photo = form.get("photo")
    photo_url = None
    if photo is not None and getattr(photo, "filename", None):
        photo_url = await girl_media.save_girl_photo(photo)
    await queries.insert_manual_girl(
        kpi, casa_id,
        name=name, age=_parse_age(form.get("age")),
        nationality=str(form.get("nationality") or ""),
        services=services, hours_today=str(form.get("hours_today") or ""),
        available_today=(form.get("available") == "on"),
        send_photo=(form.get("send_photo") == "on"),
        photo_url=photo_url,
    )
    await team.audit(
        kpi, action="girl_add", actor_label=user.display_name, user_id=user.id,
        entity_type="casa", entity_id=casa_id,
    )
    return _redirect(casa_id, ok="chica")


# ── Quitar una chica (soft-delete: active=FALSE) ─────────────────────
@router.post("/casas/{casa_id}/girls/{girl_id}/delete")
async def delete_girl(
    casa_id: int, girl_id: int, request: Request, user: RequireAdmin, kpi: KpiDB
) -> Response:
    await queries.soft_delete_girl(kpi, casa_id, girl_id)
    await team.audit(
        kpi, action="girl_delete", actor_label=user.display_name, user_id=user.id,
        entity_type="casa", entity_id=casa_id,
    )
    return _redirect(casa_id, ok="chica")


# ── Toggle rápido de disponibilidad (un clic) ────────────────────────
@router.post("/casas/{casa_id}/girls/{girl_id}/toggle")
async def toggle_available(
    casa_id: int, girl_id: int, request: Request, user: RequireAdmin, kpi: KpiDB
) -> Response:
    form = await request.form()
    available = form.get("to") == "on"
    await queries.set_girl_available(kpi, casa_id, girl_id, available)
    return _redirect(casa_id, ok="chica")


# ── Precios / plus ───────────────────────────────────────────────────
@router.post("/casas/{casa_id}/rates")
async def save_rates(
    casa_id: int, request: Request, user: RequireAdmin, kpi: KpiDB
) -> Response:
    await _casa_name_or_404(kpi, casa_id)
    form = await request.form()
    # Tope de filas + longitud de campo (defensa en profundidad; no infla el JSONB).
    labels_es = form.getlist("label_es")[:_MAX_RATES]
    labels_en = form.getlist("label_en")
    prices = form.getlist("price")
    items: list[dict] = []
    for i, label in enumerate(labels_es):
        label_es = str(label).strip()[:_MAX_FIELD_LEN]
        price = str(prices[i]).strip()[:_MAX_FIELD_LEN] if i < len(prices) else ""
        if not label_es and not price:
            continue  # fila vacía → se descarta
        item = {"label_es": label_es, "price": price}
        label_en = str(labels_en[i]).strip()[:_MAX_FIELD_LEN] if i < len(labels_en) else ""
        if label_en:
            item["label_en"] = label_en
        items.append(item)
    await queries.update_casa_rates(kpi, casa_id, items)
    await team.audit(
        kpi, action="rates_update", actor_label=user.display_name, user_id=user.id,
        entity_type="casa", entity_id=casa_id,
    )
    return _redirect(casa_id, ok="precios")


# ── Importar desde la web (botón) ────────────────────────────────────
@router.post("/casas/{casa_id}/sync")
async def trigger_sync(
    casa_id: int, request: Request, user: RequireAdmin, kpi: KpiDB, arq: Arq
) -> Response:
    """Encola una importación NO destructiva SOLO para esta casa desde la web
    (website_sync_job(casa_id)). Solo añade chicas nuevas y refresca fotos; nunca
    pisa lo que gestionas a mano en el panel."""
    await _casa_name_or_404(kpi, casa_id)
    await arq.enqueue_job("website_sync_job", casa_id)
    await team.audit(
        kpi, action="web_sync_trigger", actor_label=user.display_name, user_id=user.id,
        entity_type="casa", entity_id=casa_id,
    )
    return _redirect(casa_id, ok="sync")
