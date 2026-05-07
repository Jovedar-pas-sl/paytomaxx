"""POST endpoints for on-demand analysis: meta-analysis + individual + bulk.

Routes:
  POST /casas/<id>/meta-analyses[?wa_number_id=N]   — enqueue meta-analysis (202/409/400)
  GET  /casas/<id>/meta-analyses/latest-state[?wa_number_id=N]  — JSON: {state: empty|running|done}
  POST /casas/<id>/analyze-pending                  — enqueue bulk analyze of all unanalyzed
  POST /conversation/<id>/analyze                   — enqueue single conversation analysis
"""

from __future__ import annotations

import time

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse, Response

from app import queries
from app.analyzer import progress as prog
from app.deps import Arq, CurrentUser, KpiDB, Redis

router = APIRouter()


def _meta_running_key(casa_id: int, wa_number_id: int | None) -> str:
    """Redis SETNX key — separate slot per (casa, wa_number) so a per-WA
    meta-analysis doesn't collide with a casa-wide one and vice versa."""
    if wa_number_id is None:
        return f"casa:{casa_id}:meta_running"
    return f"casa:{casa_id}:wa:{wa_number_id}:meta_running"


# ── Meta-analysis ──────────────────────────────────────────────────
@router.post("/casas/{casa_id}/meta-analyses")
async def enqueue_meta_analysis(
    casa_id: int,
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
    redis: Redis,
    arq: Arq,
    wa_number_id: int | None = Query(default=None),
) -> Response:
    """Enqueue a meta-analysis job. When ``wa_number_id`` is provided, the
    sample is restricted to that WhatsApp; otherwise the whole casa.
    Both modes can run concurrently (separate Redis slots)."""
    # Validate — ≥10 analyzed convs (in scope: per-WA when filtered)
    analyzed_count = await queries.count_analyzed_for_casa(
        kpi, casa_id, wa_number_id=wa_number_id
    ) if wa_number_id is not None else await queries.count_analyzed_for_casa(kpi, casa_id)
    if analyzed_count < 10:
        scope = f"este WhatsApp ({wa_number_id})" if wa_number_id else "esta casa"
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Mínimo 10 conversaciones analizadas en {scope} (actualmente: {analyzed_count})",
        )

    # Rate limit — Redis SETNX for 10 min, scoped per (casa, wa)
    key = _meta_running_key(casa_id, wa_number_id)
    acquired = await redis.set(key, "1", nx=True, ex=600)
    if not acquired:
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            headers={"Retry-After": "300"},
            content={"error": {"code": "already_running",
                               "message": "Meta-análisis ya en curso"}},
        )

    # Enqueue job — pass wa_number_id when scoped
    if wa_number_id is not None:
        job = await arq.enqueue_job("meta_analyze_casa_job", casa_id, wa_number_id)
    else:
        job = await arq.enqueue_job("meta_analyze_casa_job", casa_id)

    return JSONResponse(
        status_code=status.HTTP_202_ACCEPTED,
        content={"data": {"job_id": job.job_id if job else "unknown",
                          "estimated_seconds": 8,
                          "wa_number_id": wa_number_id}},
    )


@router.get("/casas/{casa_id}/meta-analyses/progress")
async def meta_analysis_progress(
    casa_id: int,
    user: CurrentUser,  # noqa: ARG001
    redis: Redis,
    wa_number_id: int | None = Query(default=None),
) -> dict:
    """Live progress of an in-flight meta-analysis.

    Frontend polls this every ~1s after a successful POST /meta-analyses.
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


# ── Bulk analyze pending ───────────────────────────────────────────
@router.post("/casas/{casa_id}/analyze-pending")
async def enqueue_bulk_analyze(
    casa_id: int,
    request: Request,
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
    redis: Redis,
    arq: Arq,
    wa_number_id: int | None = Query(default=None),
    since_hours: int | None = Query(default=24, ge=1, le=720),
    auto_meta: bool = Query(default=False),
) -> Response:
    """Enqueue bulk analysis. With ``auto_meta=true`` the worker also runs
    the meta-analysis at the end so the frontend gets a chained progress
    bar (bulk → meta) without a second user click.

    Defaults reflect the on-demand "Generar informe" flow: last 24h, open +
    closed, re-analyze dirty conversations (those with new msgs after their
    previous analysis).
    """
    body = await request.json() if await request.body() else {}
    if not body.get("confirmed"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing confirmation — frontend must send {confirmed: true}",
        )

    ids = await queries.list_unanalyzed_conversation_ids(
        kpi, casa_id,
        wa_number_id=wa_number_id,
        since_hours=since_hours,
        include_open=True,
        redo_dirty=True,
        limit=500,
    )

    # Even if no convs need analyzing, still enqueue when auto_meta is set so
    # the frontend chain progresses to the meta phase using existing analyses.
    if not ids and not auto_meta:
        return JSONResponse(
            status_code=status.HTTP_200_OK,
            content={"data": {"enqueued_count": 0, "message": "Nothing to analyze"}},
        )

    # When auto_meta, also reserve the meta running flag here so the
    # /meta-analyses/progress endpoint returns 'queued' immediately and
    # any concurrent meta trigger gets a 409.
    if auto_meta:
        meta_flag = _meta_running_key(casa_id, wa_number_id)
        await redis.set(meta_flag, "1", nx=True, ex=900)  # 15 min cushion for chain

    await arq.enqueue_job(
        "analyze_conversations_bulk_job",
        casa_id, wa_number_id, since_hours, True, True, auto_meta,
    )

    estimated_cost_usd = round(len(ids) * 0.003, 2)
    return JSONResponse(
        status_code=status.HTTP_202_ACCEPTED,
        content={"data": {
            "enqueued_count": len(ids),
            "estimated_cost_usd": estimated_cost_usd,
            "wa_number_id": wa_number_id,
            "since_hours": since_hours,
            "auto_meta": auto_meta,
        }},
    )


@router.get("/casas/{casa_id}/analyze-pending/progress")
async def bulk_analyze_progress(
    casa_id: int,
    user: CurrentUser,  # noqa: ARG001
    redis: Redis,
    wa_number_id: int | None = Query(default=None),
) -> dict:
    """Live progress of in-flight bulk analysis (parallel with semaphore=5)."""
    pkey = prog.progress_key("bulk", casa_id, wa_number_id)
    p = await prog.get_progress(redis, pkey)
    if not p:
        return {"phase": "idle", "pct": 0, "message": "",
                "elapsed_s": 0, "eta_s": None, "state": "empty"}

    elapsed = max(0, int(time.time() - p["started_at"]))
    pct = p.get("pct", 0)
    eta: int | None = None
    if 0 < pct < 100:
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


# ── Single conversation analysis ───────────────────────────────────
@router.post("/conversation/{conversation_id}/analyze")
async def enqueue_single_analyze(
    conversation_id: int,
    user: CurrentUser,  # noqa: ARG001
    redis: Redis,
    arq: Arq,
) -> Response:
    # Per-conv rate limit to prevent double-click spam (30s)
    key = f"conv:{conversation_id}:analyze_running"
    acquired = await redis.set(key, "1", nx=True, ex=30)
    if not acquired:
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content={"error": {"code": "already_running",
                               "message": "Analyzing this conversation"}},
        )

    job = await arq.enqueue_job("analyze_conversation_job", conversation_id)
    return JSONResponse(
        status_code=status.HTTP_202_ACCEPTED,
        content={"data": {"job_id": job.job_id if job else "unknown"}},
    )


@router.get("/conversation/{conversation_id}/analysis-state")
async def single_analysis_state(
    conversation_id: int,
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
    redis: Redis,
) -> dict:
    """Polled by UI to detect when a single-conv analysis is done."""
    flag = await redis.get(f"conv:{conversation_id}:analyze_running")
    if flag:
        return {"state": "running"}
    async with kpi.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT analyzed_at FROM analysis WHERE conversation_id = $1",
            conversation_id,
        )
    if row:
        return {"state": "done", "analyzed_at": row["analyzed_at"].isoformat()}
    return {"state": "empty"}
