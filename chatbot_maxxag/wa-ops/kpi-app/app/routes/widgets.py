"""HTMX fragment endpoints — return partial HTML for live-refreshing widgets."""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse
from app import queries
from app.deps import CurrentUser, KpiDB  # noqa: F401 — CurrentUser enforces auth
from app.template_env import templates

router = APIRouter(prefix="/widget")

_DOW_LABELS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]


def _parse_cursor_ts(raw: str) -> datetime | None:
    """Parse the keyset cursor timestamp (ISO 8601) sent by the load-more sentinel.
    Empty/garbage → None, which the caller treats as "first page" (no cursor)."""
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw)
    except (ValueError, TypeError):
        return None


def _heatmap_insight(grid: list[list[int]]) -> dict | None:
    """Derive a plain-language marketing line from the 7×24 inbound grid.

    Finds the busiest contiguous 3-hour window (allowing wrap past midnight,
    e.g. 22h–01h) on its best day, plus a representative dead window. Returns
    None when there is no inbound data at all (template shows a neutral note).

    grid[day][hour]: day 0=Monday..6=Sunday (caller already maps it).
    """
    total = sum(sum(row) for row in grid)
    if total == 0:
        return None

    WINDOW = 3
    best_day = 0
    best_start = 0
    best_sum = -1
    for day in range(7):
        row = grid[day]
        for start in range(24):
            # contiguous 3h window, wrapping across midnight on the same day row
            s = sum(row[(start + k) % 24] for k in range(WINDOW))
            if s > best_sum:
                best_sum, best_day, best_start = s, day, start

    busy_end = (best_start + WINDOW) % 24

    # Dead window: quietest 3h slot summed across ALL days (when nobody writes).
    hour_totals = [sum(grid[d][h] for d in range(7)) for h in range(24)]
    dead_start = 0
    dead_sum = None
    for start in range(24):
        s = sum(hour_totals[(start + k) % 24] for k in range(WINDOW))
        if dead_sum is None or s < dead_sum:
            dead_sum, dead_start = s, start
    dead_end = (dead_start + WINDOW) % 24

    return {
        "busy_day": _DOW_LABELS[best_day],
        "busy_start": best_start,
        "busy_end": busy_end,
        "busy_count": best_sum,
        "dead_start": dead_start,
        "dead_end": dead_end,
    }


def _sparkline_points(series: list[int], w: int = 100, h: int = 32) -> str:
    """SVG polyline points from a numeric series (normalized to the viewBox)."""
    if not series or len(series) < 2:
        return ""
    lo, hi = min(series), max(series)
    rng = (hi - lo) or 1
    n = len(series)
    pts = []
    for i, v in enumerate(series):
        x = i * w / (n - 1)
        y = h - ((v - lo) / rng) * (h - 4) - 2
        pts.append(f"{x:.0f},{y:.0f}")
    return " ".join(pts)


@router.get("/kpis", response_class=HTMLResponse)
async def widget_kpis(
    request: Request,
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
) -> HTMLResponse:
    kpis = await queries.get_dashboard_kpis(kpi)
    extras = await queries.get_kpi_extras(kpi)
    yest = extras.conv_yesterday
    conv_delta = round((kpis.total_conversations_today - yest) / yest * 100) if yest else None
    return templates.TemplateResponse(
        request,
        "partials/kpi_grid.html",
        {
            "kpis": kpis,
            "extras": extras,
            "conv_spark": _sparkline_points(extras.conv_series),
            "conv_delta": conv_delta,
        },
    )


@router.get("/recent-conversations", response_class=HTMLResponse)
async def widget_recent_conversations(
    request: Request,
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
) -> HTMLResponse:
    # Rich "incoming conversations" feed (notificaciones): reuse list_conversations
    # ordered most-recent-first — brings preview, unread, mood, conv_probability,
    # and "quién contestó" attribution (last_dir / last_out_kind / last_out_agent).
    #
    # Show AT LEAST the last 2 hours (capped at 60 so a busy spell can't blow up
    # the 10s-polled fragment). When it's quiet and <14 land in 2h, fall back to
    # the 14 most recent so the feed is never near-empty.
    items, _ = await queries.list_conversations(
        kpi, order="recent", since_hours=2, limit=60
    )
    if len(items) < 14:
        items, _ = await queries.list_conversations(kpi, order="recent", limit=14)
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
    insight = _heatmap_insight(grid)
    return templates.TemplateResponse(
        request,
        "partials/heatmap.html",
        {"grid": grid, "max_val": max_val, "insight": insight},
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
    cursor_ts: str = "",
    cursor_id: int = 0,
    unanswered: bool = False,
    search: str = "",
    mood: str = "",
    status: str = "",
    handler: str = "",
    mode: str = "",
    limit: int = 50,
) -> HTMLResponse:
    """HTMX fragment: chats list + KEYSET load-more sentinel for infinite scroll.

    Pagination is cursor-based: cursor_ts/cursor_id are the (last_message_at, id)
    of the previous page's last row (see queries.list_conversations_page) — O(log n)
    and stable while new messages keep arriving. All filters compose: period,
    unanswered, search (name/phone), mood, status, handler, mode.
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
    search_q = (search or "").strip() or None
    mood_q = mood if mood in {"curioso", "decidido", "calenton", "indeciso", "enfadado", "timewaster"} else None
    status_q = status if status in {"open", "resolved", "pending"} else None
    handler_q = handler if handler in {"bot", "human"} else None
    mode_q = mode if mode in {"auto", "copilot", "off"} else None
    # Keyset cursor from the previous page. An invalid/empty ts → first page.
    cur_ts = _parse_cursor_ts(cursor_ts)
    cur_id = cursor_id if cur_ts is not None else None

    rows, next_ts, next_id = await queries.list_conversations_page(
        kpi,
        casa_id=casa_id,
        wa_number_id=wa_number_id,
        since_days=since_days,
        unanswered_only=unanswered,
        handler=handler_q,
        mode=mode_q,
        search=search_q,
        mood=mood_q,
        status=status_q,
        limit=limit,
        cursor_ts=cur_ts,
        cursor_id=cur_id,
    )
    return templates.TemplateResponse(
        request,
        "partials/chat_list_fragment.html",
        {
            "casa_id": casa_id,
            "chat_rows": rows,
            "active_wa": wa,
            # El panel en línea solo existe en la vista de un número (no en TODOS),
            # así los items del load-more/búsqueda enlazan igual que el render inicial.
            "show_pane": wa != "all",
            "active_period": period,
            "active_unanswered": unanswered,
            "active_search": search_q or "",
            "active_mood": mood_q or "",
            "active_status": status_q or "",
            "active_handler": handler_q or "",
            "active_mode": mode_q or "",
            # Keyset paging: is_first_page drives the empty-state; page_key keeps the
            # rows-div id unique per batch; next_cursor_* build the sentinel URL.
            "is_first_page": cur_ts is None,
            "page_key": cur_id or 0,
            "next_cursor_ts": next_ts.isoformat() if next_ts else "",
            "next_cursor_id": next_id or 0,
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
            "agent_generated": m.agent_generated,
        }
        for m in messages
    ]
    return templates.TemplateResponse(
        request,
        "partials/conversation_messages.html",
        {"conversation_id": conversation_id, "messages": msgs},
    )
