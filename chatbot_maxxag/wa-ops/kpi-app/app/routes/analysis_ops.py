"""Endpoints for the casa/número informe (block analyzer).

Routes:
  POST /casas/<id>/block-analysis[?wa_number_id=N&since_hours=&max_convs=&hour_from=&hour_to=]
        — enqueue the block analyzer (reads transcripts → informe in one Claude call)
  GET  /casas/<id>/meta-analyses/progress[?wa_number_id=N]       — live progress (polled by UI)
  GET  /casas/<id>/meta-analyses/latest-state[?wa_number_id=N]   — JSON: {state: empty|running|done}

The per-conversation analysis pipeline (single + bulk + meta enqueue routes) was
retired — informes now come exclusively from the block analyzer above, which
shares the same Redis progress key + running flag so the existing overlay UI
keeps working unchanged.
"""

from __future__ import annotations

import time

from fastapi import APIRouter, Query, status
from fastapi.responses import JSONResponse, Response

from app import queries
from app.analyzer import progress as prog
from app.deps import Arq, CurrentUser, KpiDB, Redis

router = APIRouter()


def _meta_running_key(casa_id: int, wa_number_id: int | None) -> str:
    """Redis SETNX key — separate slot per (casa, wa_number) so a per-WA
    informe doesn't collide with a casa-wide one and vice versa."""
    if wa_number_id is None:
        return f"casa:{casa_id}:meta_running"
    return f"casa:{casa_id}:wa:{wa_number_id}:meta_running"


# ── Block analysis (transcripts → informe in ONE Claude call) ───────
@router.post("/casas/{casa_id}/block-analysis")
async def enqueue_block_analysis(
    casa_id: int,
    user: CurrentUser,  # noqa: ARG001
    redis: Redis,
    arq: Arq,
    wa_number_id: int | None = Query(default=None),
    since_hours: int = Query(default=168, ge=1, le=8760),
    max_convs: int = Query(default=200, ge=1, le=500),
    hour_from: int | None = Query(default=None, ge=0, le=23),
    hour_to: int | None = Query(default=None, ge=0, le=23),
) -> Response:
    """Enqueue the block analyzer. Reads conversation TRANSCRIPTS directly in one
    batch Claude call — no per-conversation analysis required, so there is no
    ≥10-analyzed precondition.

    Controls: ``since_hours`` (período), ``hour_from``/``hour_to`` (franja horaria
    Europe/Madrid, supports wrap-around), ``max_convs`` (nº de conversaciones).
    Reuses the meta running flag + meta progress key so the existing overlay UI
    works unchanged."""
    # Reserve the same per-scope slot (so the progress endpoint reports 'queued'
    # immediately and concurrent triggers get a 409).
    key = _meta_running_key(casa_id, wa_number_id)
    acquired = await redis.set(key, "1", nx=True, ex=900)
    if not acquired:
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            headers={"Retry-After": "300"},
            content={"error": {"code": "already_running",
                               "message": "Informe ya en curso"}},
        )

    job = await arq.enqueue_job(
        "block_analyze_casa_job",
        casa_id, wa_number_id, since_hours, max_convs, hour_from, hour_to,
    )

    return JSONResponse(
        status_code=status.HTTP_202_ACCEPTED,
        content={"data": {
            "job_id": job.job_id if job else "unknown",
            "estimated_seconds": 90,
            "wa_number_id": wa_number_id,
            "since_hours": since_hours,
            "max_convs": max_convs,
            "hour_from": hour_from,
            "hour_to": hour_to,
        }},
    )


@router.get("/casas/{casa_id}/meta-analyses/progress")
async def meta_analysis_progress(
    casa_id: int,
    user: CurrentUser,  # noqa: ARG001
    redis: Redis,
    wa_number_id: int | None = Query(default=None),
) -> dict:
    """Live progress of an in-flight informe (block analyzer).

    Frontend polls this every ~1s after a successful POST /block-analysis.
    Returns ``{phase, pct, message, elapsed_s, eta_s, state}``:
      - state=running while the worker is publishing updates
      - state=done when phase==done (frontend reloads)
      - state=empty when nothing is in flight (frontend stops polling)
    """
    pkey = prog.progress_key("meta", casa_id, wa_number_id)
    p = await prog.get_progress(redis, pkey)

    if not p:
        # No progress key — check legacy running flag for the queued window
        # between POST accept and worker pickup
        flag = await redis.get(_meta_running_key(casa_id, wa_number_id))
        if flag:
            return {
                "phase": "queued", "pct": 5, "message": "En cola…",
                "elapsed_s": 0, "eta_s": None, "state": "running",
            }
        return {"phase": "idle", "pct": 0, "message": "",
                "elapsed_s": 0, "eta_s": None, "state": "empty"}

    elapsed = max(0, int(time.time() - p["started_at"]))
    eta: int | None = None
    pct = p.get("pct", 0)
    if 0 < pct < 100:
        # Naïve ETA: extrapolate elapsed/pct ratio. Good enough for UX.
        eta = max(0, int(elapsed * (100 - pct) / pct))

    state = "done" if p.get("phase") == "done" else (
        "error" if p.get("phase") == "error" else "running"
    )
    return {
        "phase": p.get("phase", "running"),
        "pct": pct,
        "message": p.get("message", ""),
        "elapsed_s": elapsed,
        "eta_s": eta,
        "state": state,
    }


@router.get("/casas/{casa_id}/meta-analyses/latest-state")
async def meta_analysis_state(
    casa_id: int,
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
    redis: Redis,
    wa_number_id: int | None = Query(default=None),
) -> dict:
    # If running flag exists for this scope → running
    flag = await redis.get(_meta_running_key(casa_id, wa_number_id))
    if flag:
        return {"state": "running"}
    latest = await queries.get_latest_meta_analysis(kpi, casa_id)
    # If asking for per-WA state, only report "done" when the latest run
    # matches that wa_number_id; otherwise keep "empty" so the user knows
    # they need to launch a per-WA run.
    if latest and (wa_number_id is None or latest.wa_number_id == wa_number_id):
        return {"state": "done", "run_at": latest.run_at.isoformat()}
    return {"state": "empty"}
