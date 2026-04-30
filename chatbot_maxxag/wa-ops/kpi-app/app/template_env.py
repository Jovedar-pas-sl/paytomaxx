"""Shared Jinja2Templates instance with the project's custom filters.

All routes import `templates` from here so filters are registered once.

Filters:
  - `local`  → converts a datetime to Europe/Madrid for human display.
               Naive datetimes are assumed UTC. Use in templates:
                   {{ (m.created_at | local).strftime('%H:%M') }}
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


templates = Jinja2Templates(directory="app/templates")
templates.env.filters["local"] = _to_local
