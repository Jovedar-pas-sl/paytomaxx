"""Admin pages: cost dashboard + future ops tooling.

Routes:
  GET /admin/costs   — Claude API spending: today/week/month + breakdown
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse

from app.deps import CurrentUser, KpiDB
from app.template_env import templates

router = APIRouter()


@router.get("/admin/costs", response_class=HTMLResponse)
async def admin_costs(
    request: Request,
    user: CurrentUser,
    db: KpiDB,
) -> HTMLResponse:
    """Claude API cost summary. Sums claude_cost_usd from analysis +
    casa_meta_analysis tables across multiple time windows + per-casa
    breakdown for the current month.
    """
    async with db.acquire() as conn:
        # Per-window totals: today, last 7 days, this month, all-time.
        # Combines per-conv analyses with meta-analyses since both spend money.
        totals = await conn.fetchrow(
            """
            WITH cost_events AS (
                SELECT analyzed_at AS ts, claude_cost_usd AS cost,
                       claude_tokens_in AS tin, claude_tokens_out AS tout
                FROM analysis
                WHERE claude_cost_usd IS NOT NULL
                UNION ALL
                SELECT run_at AS ts, claude_cost_usd AS cost,
                       claude_tokens_in AS tin, claude_tokens_out AS tout
                FROM casa_meta_analysis
                WHERE claude_cost_usd IS NOT NULL
            )
            SELECT
              coalesce(sum(cost) FILTER (WHERE ts::date = current_date), 0)::float AS today,
              coalesce(sum(cost) FILTER (WHERE ts > now() - interval '7 days'), 0)::float AS week,
              coalesce(sum(cost) FILTER (WHERE date_trunc('month', ts) = date_trunc('month', now())), 0)::float AS month,
              coalesce(sum(cost), 0)::float AS all_time,
              coalesce(sum(tin) FILTER (WHERE ts > now() - interval '30 days'), 0)::int AS tokens_in_30d,
              coalesce(sum(tout) FILTER (WHERE ts > now() - interval '30 days'), 0)::int AS tokens_out_30d,
              count(*) FILTER (WHERE ts::date = current_date)::int AS calls_today,
              count(*) FILTER (WHERE ts > now() - interval '30 days')::int AS calls_30d
            FROM cost_events
            """
        )

        # Per-casa breakdown for current month
        per_casa = await conn.fetch(
            """
            WITH cost_events AS (
                SELECT a.account_id AS casa_id, a.analyzed_at AS ts,
                       a.claude_cost_usd AS cost, 'analysis' AS kind
                FROM analysis a
                WHERE a.claude_cost_usd IS NOT NULL
                  AND date_trunc('month', a.analyzed_at) = date_trunc('month', now())
                UNION ALL
                SELECT m.account_id AS casa_id, m.run_at AS ts,
                       m.claude_cost_usd AS cost, 'meta' AS kind
                FROM casa_meta_analysis m
                WHERE m.claude_cost_usd IS NOT NULL
                  AND date_trunc('month', m.run_at) = date_trunc('month', now())
            )
            SELECT
              ce.casa_id,
              c.name AS casa_name,
              coalesce(sum(ce.cost) FILTER (WHERE kind = 'analysis'), 0)::float AS analysis_cost,
              count(*) FILTER (WHERE kind = 'analysis')::int AS analysis_calls,
              coalesce(sum(ce.cost) FILTER (WHERE kind = 'meta'), 0)::float AS meta_cost,
              count(*) FILTER (WHERE kind = 'meta')::int AS meta_calls,
              coalesce(sum(ce.cost), 0)::float AS total
            FROM cost_events ce
            LEFT JOIN casa c ON c.id = ce.casa_id
            GROUP BY ce.casa_id, c.name
            ORDER BY total DESC
            """
        )

        # Last 30 days daily series for the trend chart
        daily = await conn.fetch(
            """
            WITH cost_events AS (
                SELECT analyzed_at::date AS day, claude_cost_usd AS cost FROM analysis
                WHERE claude_cost_usd IS NOT NULL AND analyzed_at > now() - interval '30 days'
                UNION ALL
                SELECT run_at::date AS day, claude_cost_usd AS cost FROM casa_meta_analysis
                WHERE claude_cost_usd IS NOT NULL AND run_at > now() - interval '30 days'
            )
            SELECT day, sum(cost)::float AS cost, count(*)::int AS calls
            FROM cost_events
            GROUP BY day
            ORDER BY day ASC
            """
        )

    return templates.TemplateResponse(
        request,
        "admin_costs.html",
        {
            "user": user,
            "totals": dict(totals) if totals else {},
            "per_casa": [dict(r) for r in per_casa],
            "daily": [dict(r) for r in daily],
        },
    )
