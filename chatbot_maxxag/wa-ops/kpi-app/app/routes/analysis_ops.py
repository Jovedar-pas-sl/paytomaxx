"""POST endpoints for on-demand analysis: meta-analysis + individual + bulk.

Routes:
  POST /casas/<id>/meta-analyses          — enqueue meta-analysis (202/409/400)
  GET  /casas/<id>/meta-analyses/latest-state  — JSON: {state: empty|running|done}
  POST /casas/<id>/analyze-pending        — enqueue bulk analyze of all unanalyzed
  POST /conversation/<id>/analyze         — enqueue single conversation analysis
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import JSONResponse, Response

from app import queries
from app.deps import Arq, CurrentUser, KpiDB, Redis

router = APIRouter()


# ── Meta-analysis ──────────────────────────────────────────────────
@router.post("/casas/{casa_id}/meta-analyses")
async def enqueue_meta_analysis(
    casa_id: int,
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
    redis: Redis,
    arq: Arq,
) -> Response:
    # Validate — ≥10 analyzed convs
    analyzed_count = await queries.count_analyzed_for_casa(kpi, casa_id)
    if analyzed_count < 10:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Mínimo 10 conversaciones analizadas (actualmente: {analyzed_count})",
        )

    # Rate limit — Redis SETNX for 5 min
    key = f"casa:{casa_id}:meta_running"
    acquired = await redis.set(key, "1", nx=True, ex=600)
    if not acquired:
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            headers={"Retry-After": "300"},
            content={"error": {"code": "already_running",
                               "message": "Meta-análisis ya en curso"}},
        )

    # Enqueue job
    job = await arq.enqueue_job("meta_analyze_casa_job", casa_id)

    return JSONResponse(
        status_code=status.HTTP_202_ACCEPTED,
        content={"data": {"job_id": job.job_id if job else "unknown",
                          "estimated_seconds": 8}},
    )


@router.get("/casas/{casa_id}/meta-analyses/latest-state")
async def meta_analysis_state(
    casa_id: int,
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
    redis: Redis,
) -> dict:
    # If running flag exists → running
    flag = await redis.get(f"casa:{casa_id}:meta_running")
    if flag:
        return {"state": "running"}
    latest = await queries.get_latest_meta_analysis(kpi, casa_id)
    if latest:
        return {"state": "done", "run_at": latest.run_at.isoformat()}
    return {"state": "empty"}


# ── Bulk analyze pending ───────────────────────────────────────────
@router.post("/casas/{casa_id}/analyze-pending")
async def enqueue_bulk_analyze(
    casa_id: int,
    request: Request,
    user: CurrentUser,  # noqa: ARG001
    kpi: KpiDB,
    redis: Redis,  # noqa: ARG001 — reserved for future rate limiting
    arq: Arq,
) -> Response:
    body = await request.json() if await request.body() else {}
    if not body.get("confirmed"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing confirmation — frontend must send {confirmed: true}",
        )

    ids = await queries.list_unanalyzed_conversation_ids(kpi, casa_id, limit=500)
    if not ids:
        return JSONResponse(
            status_code=status.HTTP_200_OK,
            content={"data": {"enqueued_count": 0, "message": "Nothing to analyze"}},
        )

    # Enqueue the bulk job (which will process ids internally)
    await arq.enqueue_job("analyze_conversations_bulk_job", casa_id)

    estimated_cost_usd = round(len(ids) * 0.003, 2)
    return JSONResponse(
        status_code=status.HTTP_202_ACCEPTED,
        content={"data": {
            "enqueued_count": len(ids),
            "estimated_cost_usd": estimated_cost_usd,
        }},
    )


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
