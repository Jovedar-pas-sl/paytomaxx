"""HTMX fragment endpoints — return partial HTML for live-refreshing widgets."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse
from app import queries
from app.deps import CurrentUser, KpiDB  # noqa: F401 — CurrentUser enforces auth
from app.template_env import templates

router = APIRouter(prefix="/widget")
@router.get("/kpis", response_class=HTMLResponse)
async def widget_kpis(
    request: Request,
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
) -> HTMLResponse:
    kpis = await queries.get_dashboard_kpis(kpi)
    return templates.TemplateResponse(request, "partials/kpi_grid.html", {"kpis": kpis})


@router.get("/recent-conversations", response_class=HTMLResponse)
async def widget_recent_conversations(
    request: Request,
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
) -> HTMLResponse:
    items = await queries.list_recent_conversations(kpi, limit=15)
    return templates.TemplateResponse(
        request,
        "partials/recent_conversations.html",
        {"items": items},
    )


@router.get("/heatmap", response_class=HTMLResponse)
async def widget_heatmap(
    request: Request,
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
) -> HTMLResponse:
    grid = await queries.get_heatmap_last_7_days(kpi)
    max_val = max((max(row) if row else 0) for row in grid) or 1
    return templates.TemplateResponse(
        request,
        "partials/heatmap.html",
        {"grid": grid, "max_val": max_val},
    )


@router.get("/casas", response_class=HTMLResponse)
async def widget_casas(
    request: Request,
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
) -> HTMLResponse:
    casas = await queries.list_casas(kpi)
    return templates.TemplateResponse(request, "partials/casas_list.html", {"casas": casas})


VALID_PERIODS = {"24h", "7d", "30d", "90d", "all"}
PERIOD_DAYS = {"24h": 1, "7d": 7, "30d": 30, "90d": 90, "all": 3650}


@router.get("/casa/{casa_id}/chats", response_class=HTMLResponse)
async def widget_casa_chats(
    request: Request,
    casa_id: int,
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
    wa: str = "all",
    period: str = "all",
    offset: int = 0,
    unanswered: bool = False,
    search: str = "",
    mood: str = "",
    status: str = "",
    limit: int = 50,
) -> HTMLResponse:
    """HTMX fragment: chats list + load-more sentinel for infinite scroll.

    All filters compose: period, unanswered, search (name/phone),
    mood (one of curioso/decidido/calenton/indeciso/enfadado/timewaster),
    status (open/resolved/pending). offset drives infinite scroll.
    """
    wa_number_id: int | None = None
    if wa != "all":
        try:
            wa_number_id = int(wa)
        except ValueError:
            pass
    if period not in VALID_PERIODS:
        period = "all"
    days = PERIOD_DAYS[period]
    since_days = None if days >= 3650 else days
    limit = max(1, min(int(limit), 100))
    offset = max(0, int(offset))
    search_q = (search or "").strip() or None
    mood_q = mood if mood in {"curioso", "decidido", "calenton", "indeciso", "enfadado", "timewaster"} else None
    status_q = status if status in {"open", "resolved", "pending"} else None

    rows, total = await queries.list_conversations(
        kpi,
        casa_id=casa_id,
        wa_number_id=wa_number_id,
        since_days=since_days,
        unanswered_only=unanswered,
        search=search_q,
        mood=mood_q,
        status=status_q,
        limit=limit,
        offset=offset,
    )
    next_offset = offset + len(rows) if (offset + len(rows)) < total else None
    return templates.TemplateResponse(
        request,
        "partials/chat_list_fragment.html",
        {
            "casa_id": casa_id,
            "chat_rows": rows,
            "active_wa": wa,
            "active_period": period,
            "active_unanswered": unanswered,
            "active_search": search_q or "",
            "active_mood": mood_q or "",
            "active_status": status_q or "",
            "offset": offset,
            "next_offset": next_offset,
            "total": total,
        },
    )


@router.get("/conversation/{conversation_id}/messages", response_class=HTMLResponse)
async def widget_conversation_messages(
    request: Request,
    conversation_id: int,
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
) -> HTMLResponse:
    """HTMX fragment: messages scroll area (polled every 3s)."""
    messages = await queries.list_messages_for_conversation(kpi, conversation_id)
    await queries.clear_unread(kpi, conversation_id)
    msgs = [
        {
            "id": m.id,
            "content": m.body or "",
            "message_type": 0 if m.direction == "in" else 1,
            "created_at": m.created_at,
            "ack": m.ack,
            "media_url": m.media_url,
            "media_mime": m.media_mime,
        }
        for m in messages
    ]
    return templates.TemplateResponse(
        request,
        "partials/conversation_messages.html",
        {"conversation_id": conversation_id, "messages": msgs},
    )
