"""Shared Jinja2Templates instance with the project's custom filters.

All routes import `templates` from here so filters are registered once.

Filters:
  - `local`        → converts datetime to Europe/Madrid for human display.
                     Naive datetimes are assumed UTC. Use in templates:
                         {{ (m.created_at | local).strftime('%H:%M') }}
  - `format_phone` → formats a raw phone string ('34644041416') into a
                     human-readable form ('+34 644 04 14 16'). Returns '—'
                     for empty input.

Globals:
  - `resolve_pill` → app.agent.pill.resolve_pill, the SINGLE SOURCE OF TRUTH for
                     the per-conversation agent status pill. Both the chat-list
                     and the conversation header render from its PillState so the
                     17 pill unit tests guard the rendered path.
  - `is_hot_lead`  → True when a conv_probability is at/above HOT_LEAD_THRESHOLD,
                     so the 🔥 badge threshold lives in one place (queries.py),
                     never hardcoded in a template.
"""
from __future__ import annotations

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from fastapi.templating import Jinja2Templates

from app.agent.pill import resolve_pill
from app.queries import HOT_LEAD_THRESHOLD

LOCAL_TZ = ZoneInfo("Europe/Madrid")


def _to_local(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(LOCAL_TZ)


def _format_phone(p: str | None) -> str:
    """+34 644041416 → +34 644 04 14 16. Falls back to raw input."""
    if not p:
        return "—"
    s = "".join(ch for ch in str(p) if ch.isdigit())
    if len(s) >= 11:  # country code + 9-digit ES number
        return f"+{s[:2]} {s[2:5]} {s[5:7]} {s[7:9]} {s[9:]}"
    return f"+{s}" if s else "—"


def _is_hot_lead(prob: float | None) -> bool:
    """True iff a conv_probability is at/above the hot-lead threshold.

    Keeps the 🔥-badge cutoff in one place (queries.HOT_LEAD_THRESHOLD) instead
    of a magic number in the template."""
    return prob is not None and prob >= HOT_LEAD_THRESHOLD


templates = Jinja2Templates(directory="app/templates")
templates.env.filters["local"] = _to_local
templates.env.filters["format_phone"] = _format_phone
# Globals — single sources of truth shared by the templates (see module docstring).
templates.env.globals["resolve_pill"] = resolve_pill
templates.env.globals["is_hot_lead"] = _is_hot_lead
