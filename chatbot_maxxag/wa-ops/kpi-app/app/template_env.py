"""Shared Jinja2Templates instance with the project's custom filters.

All routes import `templates` from here so filters are registered once.

Filters:
  - `local`        → converts datetime to Europe/Madrid for human display.
                     Naive datetimes are assumed UTC. Use in templates:
                         {{ (m.created_at | local).strftime('%H:%M') }}
  - `format_phone` → formats a raw phone string ('34644041416') into a
                     human-readable form ('+34 644 04 14 16'). Returns '—'
                     for empty input.
"""
from __future__ import annotations

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from fastapi.templating import Jinja2Templates

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


templates = Jinja2Templates(directory="app/templates")
templates.env.filters["local"] = _to_local
templates.env.filters["format_phone"] = _format_phone
