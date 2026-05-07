"""Redis-backed progress reporting for long-running analyzer jobs.

The meta-analysis job (`meta_analyze_casa_job`) runs 30-90s and the user-facing
overlay needs to show what's happening. arq itself doesn't expose intra-job
progress, so we publish phase/percent updates to a Redis key that the frontend
polls every second.

Key shape: ``progress:{kind}:{casa_id}:{wa_number_id|all}``
TTL 600s ensures stale keys disappear if a worker crashes mid-job.
"""

from __future__ import annotations

import json
import time
from typing import Literal

Phase = Literal["queued", "fetching", "analyzing", "saving", "done", "error"]
TTL_SECONDS = 600


def progress_key(kind: str, casa_id: int, wa_number_id: int | None) -> str:
    suffix = str(wa_number_id) if wa_number_id is not None else "all"
    return f"progress:{kind}:{casa_id}:{suffix}"


async def set_progress(
    redis,
    key: str,
    *,
    phase: Phase,
    pct: int,
    message: str,
    started_at: float | None = None,
) -> None:
    payload = {
        "phase": phase,
        "pct": max(0, min(100, pct)),
        "message": message,
        "started_at": started_at if started_at is not None else time.time(),
        "updated_at": time.time(),
    }
    await redis.set(key, json.dumps(payload), ex=TTL_SECONDS)


async def get_progress(redis, key: str) -> dict | None:
    raw = await redis.get(key)
    if not raw:
        return None
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", errors="replace")
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return None


async def clear_progress(redis, key: str) -> None:
    await redis.delete(key)
