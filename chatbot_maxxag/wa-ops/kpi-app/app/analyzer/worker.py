"""arq worker — consumes background jobs from Redis.

Reads messages from the KPI-owned `message` table (populated by WAHA webhook).

Jobs:
  - block_analyze_casa_job: reads conversation transcripts directly in ONE
    batch Claude call to produce the casa/número informe (no per-conversation
    analysis).
  - auto_reply_job: the auto-reply bot.
  - waha_health_check_job (cron): stateful WAHA session recovery.
  - website_sync_job (cron + on-demand): mirror each casa's live website.
"""

from __future__ import annotations

import asyncio
import json
import logging

import asyncpg
import httpx
from arq import cron, create_pool
from arq.connections import RedisSettings

from app.agent.auto_reply import auto_reply_job
from app.agent.followup import followup_send_job, followup_sweep_job
from app.agent.website_sync import website_sync_job
from app.agent import style_harvest
from app import queries
from app.analyzer import progress as prog
from app.analyzer import skills
from app.notify import push_alert
from app.settings import get_settings

logger = logging.getLogger("analyzer.worker")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


async def startup(ctx: dict) -> None:
    import redis.asyncio as redis_async
    from app.waha_client import WahaClient
    s = get_settings()
    ctx["kpi_db"] = await asyncpg.create_pool(dsn=s.database_url, min_size=1, max_size=5)
    ctx["redis"] = redis_async.from_url(s.redis_url, decode_responses=True)
    # ArqRedis handle for ENQUEUEING jobs from inside a job/cron (the plain
    # ctx["redis"] above is a raw redis client with no enqueue_job). The
    # follow-up CRON uses this to enqueue per-conversation send jobs — mirrors
    # how deps.py builds the route-side ArqRedis.
    ctx["arq"] = await create_pool(RedisSettings.from_dsn(s.redis_url))
    # The worker process has its own WAHA client (the route's lives in app
    # state, not here). auto_reply_job uses it to mark-read / type / send.
    ctx["waha"] = WahaClient(s)
    logger.info("analyzer worker ready")


async def shutdown(ctx: dict) -> None:
    await ctx["kpi_db"].close()
    if "redis" in ctx:
        await ctx["redis"].aclose()
    if "arq" in ctx:
        await ctx["arq"].close()
    if "waha" in ctx:
        await ctx["waha"].aclose()
    logger.info("analyzer worker shut down")


async def _drift_pct(
    redis,
    key: str,
    *,
    from_pct: int,
    to_pct: int,
    duration_s: float,
    message: str,
    started_at: float,
) -> None:
    """Move pct linearly from→to over duration_s while phase=='analyzing'.

    The Claude API call is opaque so we can't report real progress. This task
    publishes a smooth visual progression (every step) until either the target
    pct is reached or the phase changes — at which point it bows out so the
    real next-phase update wins.
    """
    steps = max(to_pct - from_pct, 1)
    interval = duration_s / steps
    for i in range(steps):
        await asyncio.sleep(interval)
        current = await prog.get_progress(redis, key)
        if not current or current.get("phase") != "analyzing":
            return
        await prog.set_progress(
            redis, key,
            phase="analyzing",
            pct=from_pct + i + 1,
            message=message,
            started_at=started_at,
        )


# Spanish day labels (Monday-first) — matches the by_dow Mon..Sun mapping used
# across the worker and the heatmap template.
_DOW_LABELS_ES = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]


def _best_3h_window(by_hour: list[int]) -> tuple[int, int]:
    """Return (start_hour, summed_count) of the busiest contiguous 3-hour window.

    Treats the 24h clock as circular so windows can wrap past midnight
    (e.g. 23h→01h). ``by_hour`` is 24 ints indexed by hour 0-23.
    """
    best_start, best_sum = 0, -1
    for start in range(24):
        total = by_hour[start] + by_hour[(start + 1) % 24] + by_hour[(start + 2) % 24]
        if total > best_sum:
            best_start, best_sum = start, total
    return best_start, best_sum


def _worst_3h_window(by_hour: list[int]) -> int:
    """Return start_hour of the quietest contiguous 3-hour window (circular)."""
    worst_start, worst_sum = 0, None
    for start in range(24):
        total = by_hour[start] + by_hour[(start + 1) % 24] + by_hour[(start + 2) % 24]
        if worst_sum is None or total < worst_sum:
            worst_start, worst_sum = start, total
    return worst_start


def _window_label(start: int) -> str:
    """Format a 3-hour window starting at ``start`` as e.g. "22h–01h"."""
    end = (start + 3) % 24
    return f"{start:02d}h–{end:02d}h"


def _compute_marketing(by_hour_in: list[int], by_dow_in: list[int]) -> dict:
    """Build the marketing insight dict from inbound hour/day histograms.

    Returns ``{}`` when there is no inbound data so callers can omit the key.
    All windows are contiguous 3-hour spans (circular, wrap past midnight).
    """
    total = sum(by_hour_in)
    if total <= 0:
        return {}

    peak_hour = max(range(24), key=lambda h: by_hour_in[h])
    peak_dow = max(range(7), key=lambda d: by_dow_in[d])

    peak_start, peak_sum = _best_3h_window(by_hour_in)
    dead_start = _worst_3h_window(by_hour_in)
    peak_window_pct = round(100.0 * peak_sum / total) if total else 0

    return {
        "peak_hour": peak_hour,
        "peak_dow": peak_dow,
        "peak_dow_label": _DOW_LABELS_ES[peak_dow],
        "peak_window": _window_label(peak_start),
        "peak_window_pct": peak_window_pct,
        "dead_window": _window_label(dead_start),
    }


async def block_analyze_casa_job(
    ctx: dict,
    casa_id: int,
    wa_number_id: int | None = None,
    since_hours: int | None = 168,
    max_convs: int = 200,
    hour_from: int | None = None,
    hour_to: int | None = None,
) -> None:
    """Block analyzer — generate the casa/number informe by reading conversation
    TRANSCRIPTS directly in ONE batch Claude call (no per-conversation analysis).

    Controls:
      - ``since_hours``: time window (None = no time filter, just newest convs).
      - ``hour_from``/``hour_to``: hour-of-day window (Europe/Madrid). Keeps only
        conversations with ≥1 message in [hour_from, hour_to). Supports wrap-around
        (e.g. 20→6 = nightlife hours).
      - ``max_convs``: cap on conversations (newest first).

    Stores into the SAME ``casa_meta_analysis`` table the meta job uses, and
    reuses the EXISTING meta progress key so the current overlay UI works.
    """
    import time
    from app.analyzer.meta_analysis import run_block_analysis

    kpi: asyncpg.Pool = ctx["kpi_db"]
    redis = ctx.get("redis")
    started = time.time()
    pkey = prog.progress_key("meta", casa_id, wa_number_id)

    if redis:
        await prog.set_progress(redis, pkey, phase="fetching", pct=10,
                                message="Cargando conversaciones…", started_at=started)

    # ── Resolve scope name (casa + optional WA label) ──────────────
    async with kpi.acquire() as conn:
        name_row = await conn.fetchrow("SELECT name FROM casa WHERE id = $1", casa_id)
        if not name_row:
            logger.warning("casa %s not found", casa_id)
            if redis:
                await prog.set_progress(redis, pkey, phase="error", pct=100,
                                        message="Casa no encontrada", started_at=started)
            return
        casa_name = name_row["name"]

        wa_label = None
        if wa_number_id is not None:
            wa_row = await conn.fetchrow(
                "SELECT label FROM wa_number WHERE id = $1", wa_number_id
            )
            wa_label = wa_row["label"] if wa_row else None

        # ── Select conversation IDs (newest first, optional window) ──
        params: list = [casa_id]
        where_parts = ["casa_id = $1"]
        if wa_number_id is not None:
            params.append(wa_number_id)
            where_parts.append(f"wa_number_id = ${len(params)}")
        if since_hours is not None:
            params.append(since_hours)
            where_parts.append(
                f"last_message_at > now() - make_interval(hours => ${len(params)})"
            )
        params.append(max(1, min(int(max_convs or 200), 500)))
        limit_idx = len(params)

        conv_rows = await conn.fetch(
            f"""
            SELECT id
            FROM conversation
            WHERE {' AND '.join(where_parts)}
            ORDER BY last_message_at DESC NULLS LAST
            LIMIT ${limit_idx}
            """,
            *params,
        )
        conv_ids = [r["id"] for r in conv_rows]

        # ── Franja horaria filter (Europe/Madrid, supports wrap-around) ──
        if conv_ids and (hour_from is not None or hour_to is not None):
            hf = hour_from if hour_from is not None else 0
            ht = hour_to if hour_to is not None else 24
            if hf <= ht:
                # Normal window [hf, ht)
                hour_cond = "h >= $2 AND h < $3"
            else:
                # Wrap-around (e.g. 20→6): h >= hf OR h < ht
                hour_cond = "h >= $2 OR h < $3"
            kept = await conn.fetch(
                f"""
                SELECT DISTINCT conversation_id
                FROM (
                    SELECT conversation_id,
                           extract(hour from created_at AT TIME ZONE 'Europe/Madrid')::int AS h
                    FROM message
                    WHERE conversation_id = ANY($1)
                ) m
                WHERE {hour_cond}
                """,
                conv_ids, hf, ht,
            )
            keep_set = {r["conversation_id"] for r in kept}
            conv_ids = [cid for cid in conv_ids if cid in keep_set]

    if not conv_ids:
        logger.info("block analyze casa %s wa %s — 0 convs after filter",
                    casa_id, wa_number_id)
        if redis:
            await prog.set_progress(redis, pkey, phase="error", pct=100,
                                    message="Sin conversaciones en ese filtro",
                                    started_at=started)
        return

    # ── Build transcripts (ordered messages, truncated) ───────────
    async with kpi.acquire() as conn:
        msg_rows = await conn.fetch(
            """
            SELECT conversation_id, direction, body,
                   to_char(created_at AT TIME ZONE 'Europe/Madrid', 'HH24:MI') AS hhmm
            FROM message
            WHERE conversation_id = ANY($1) AND body IS NOT NULL AND body <> ''
            ORDER BY conversation_id, created_at ASC
            """,
            conv_ids,
        )
    lines_by_conv: dict[int, list[str]] = {cid: [] for cid in conv_ids}
    for r in msg_rows:
        cid = r["conversation_id"]
        if cid not in lines_by_conv:
            continue
        role = "CLIENTE" if r["direction"] == "in" else "MAMAI"
        body = (r["body"] or "")[:400]
        lines_by_conv[cid].append(f"[{r['hhmm']}] {role}: {body}")
    transcripts: list[tuple[int, str]] = [
        (cid, "\n".join(lines_by_conv[cid])) for cid in conv_ids if lines_by_conv[cid]
    ]

    if not transcripts:
        if redis:
            await prog.set_progress(redis, pkey, phase="error", pct=100,
                                    message="Sin conversaciones en ese filtro",
                                    started_at=started)
        return

    scope_name = f"{casa_name} · {wa_label}" if wa_label else casa_name

    # ── Claude block analysis (with smooth drift on the bar) ───────
    drift_task: asyncio.Task | None = None
    if redis:
        await prog.set_progress(redis, pkey, phase="analyzing", pct=30,
                                message="Claude leyendo conversaciones…",
                                started_at=started)
        drift_task = asyncio.create_task(_drift_pct(
            redis, pkey,
            from_pct=30, to_pct=85, duration_s=90.0,
            message="Claude leyendo conversaciones…",
            started_at=started,
        ))

    block_token_acc: dict[str, int] = {"input": 0, "output": 0, "calls": 0}
    try:
        with skills.token_accumulator() as _block_acc:
            result = await asyncio.wait_for(
                run_block_analysis(scope_name, transcripts),
                timeout=180.0,
            )
            block_token_acc = dict(_block_acc)
    except Exception as exc:
        logger.exception("block-analysis call failed for casa %s wa %s",
                         casa_id, wa_number_id)
        if redis:
            await prog.set_progress(redis, pkey, phase="error", pct=100,
                                    message=f"Error: {type(exc).__name__}",
                                    started_at=started)
        return
    finally:
        if drift_task:
            drift_task.cancel()
            try:
                await drift_task
            except (asyncio.CancelledError, Exception):
                pass

    if redis:
        await prog.set_progress(redis, pkey, phase="saving", pct=95,
                                message="Guardando informe…", started_at=started)

    # ── SQL KPIs + INSERT — own try/except so we never stick at 'saving' ──
    try:
        async with kpi.acquire() as conn:
            dates = await conn.fetchrow(
                """
                SELECT min(created_at) AS period_start, max(created_at) AS period_end
                FROM message
                WHERE conversation_id = ANY($1)
                """,
                conv_ids,
            )

            # Reuse the kpi_row CTE from meta_analyze_casa_job — SAFE with zero
            # analysis rows (LEFT JOIN analysis), so this works on the block path
            # where conversations may have no per-conv analysis.
            kpi_row = await conn.fetchrow(
                """
                WITH last_msg AS (
                  SELECT DISTINCT ON (conversation_id)
                    conversation_id, direction
                  FROM message
                  WHERE conversation_id = ANY($1)
                  ORDER BY conversation_id, created_at DESC
                ),
                msg_count AS (
                  SELECT conversation_id, count(*)::int AS n
                  FROM message
                  WHERE conversation_id = ANY($1)
                  GROUP BY conversation_id
                ),
                sample AS (
                  SELECT
                    c.id, c.status, c.contact_id, c.created_at,
                    lm.direction      AS last_dir,
                    coalesce(mc.n, 0) AS msgs,
                    a.mood_label,
                    a.conv_probability,
                    a.rt_p50, a.rt_p90, a.rt_max,
                    a.treat_carinoso, a.treat_profesional, a.treat_vendedor, a.treat_seco,
                    jsonb_array_length(coalesce(a.red_flags, '[]'::jsonb)) AS rf_count,
                    a.red_flags,
                    a.intent->>'primary'              AS intent_primary,
                    a.escalation->>'should_escalate'  AS esc_flag
                  FROM conversation c
                  LEFT JOIN last_msg  lm ON lm.conversation_id = c.id
                  LEFT JOIN msg_count mc ON mc.conversation_id = c.id
                  LEFT JOIN analysis  a  ON a.conversation_id  = c.id
                  WHERE c.id = ANY($1)
                )
                SELECT
                  count(*)::int                                                 AS total_convs,
                  coalesce(sum(msgs), 0)::int                                   AS total_msgs,
                  coalesce(round(avg(msgs))::int, 0)                            AS avg_msgs,
                  count(DISTINCT contact_id)::int                               AS unique_clients,
                  count(*) FILTER (WHERE last_dir = 'out')::int                 AS answered,
                  count(*) FILTER (WHERE last_dir = 'in' OR last_dir IS NULL)::int AS unanswered,
                  count(*) FILTER (WHERE status = 'resolved')::int              AS resolved,
                  count(*) FILTER (WHERE status IN ('open','pending'))::int     AS open_count,
                  count(*) FILTER (WHERE esc_flag = 'true')::int                AS escalations,
                  count(*) FILTER (WHERE intent_primary = 'booking')::int       AS bookings,
                  count(*) FILTER (WHERE intent_primary = 'cotizacion')::int    AS quotes,
                  count(*) FILTER (WHERE intent_primary = 'informacion')::int   AS infos,
                  count(*) FILTER (WHERE intent_primary = 'queja')::int         AS complaints,
                  count(*) FILTER (WHERE intent_primary = 'chit_chat')::int     AS chitchat,
                  coalesce(round(100.0 * count(*) FILTER (WHERE conv_probability > 0.5)::numeric
                                 / nullif(count(conv_probability), 0))::int, 0) AS conv_rate_pct,
                  count(*) FILTER (WHERE mood_label = 'decidido')::int          AS mood_decidido,
                  count(*) FILTER (WHERE mood_label = 'curioso')::int           AS mood_curioso,
                  count(*) FILTER (WHERE mood_label = 'calenton')::int          AS mood_calenton,
                  count(*) FILTER (WHERE mood_label = 'indeciso')::int          AS mood_indeciso,
                  count(*) FILTER (WHERE mood_label = 'enfadado')::int          AS mood_enfadado,
                  count(*) FILTER (WHERE mood_label = 'timewaster')::int        AS mood_timewaster,
                  coalesce(round(avg(rt_p50) / 1000.0)::int, 0)                 AS p50_sec,
                  coalesce(round(avg(rt_p90) / 1000.0)::int, 0)                 AS p90_sec,
                  coalesce(round(max(rt_max) / 1000.0)::int, 0)                 AS max_sec,
                  coalesce(round(100.0 * count(*) FILTER (WHERE rt_p50 < 60000)::numeric
                                 / nullif(count(rt_p50), 0))::int, 0)           AS fast_pct,
                  coalesce(round(avg(treat_carinoso),    1)::float, 0)          AS avg_carinoso,
                  coalesce(round(avg(treat_profesional), 1)::float, 0)          AS avg_profesional,
                  coalesce(round(avg(treat_vendedor),    1)::float, 0)          AS avg_vendedor,
                  coalesce(round(avg(treat_seco),        1)::float, 0)          AS avg_seco,
                  coalesce(sum(rf_count), 0)::int                               AS red_flags_total
                FROM sample
                """,
                conv_ids,
            )
            kpis_dict = dict(kpi_row) if kpi_row else {}

            # ── by_hour + peak_hour + hours_top (Europe/Madrid) ──────
            hour_rows = await conn.fetch(
                """
                SELECT extract(hour from created_at AT TIME ZONE 'Europe/Madrid')::int AS hour,
                       count(*)::int AS n
                FROM message
                WHERE conversation_id = ANY($1)
                GROUP BY hour
                """,
                conv_ids,
            )
            by_hour = [0] * 24
            for hr in hour_rows:
                h = hr["hour"]
                if 0 <= h <= 23:
                    by_hour[h] = hr["n"]
            kpis_dict["by_hour"] = by_hour
            kpis_dict["peak_hour"] = (
                max(range(24), key=lambda h: by_hour[h]) if any(by_hour) else None
            )
            kpis_dict["hours_top"] = [
                {"hour": h, "count": by_hour[h]}
                for h in sorted(range(24), key=lambda h: by_hour[h], reverse=True)
                if by_hour[h] > 0
            ][:3]

            # ── by_dow (7 ints Mon..Sun, Europe/Madrid) ──────────────
            dow_rows = await conn.fetch(
                """
                SELECT extract(dow from created_at AT TIME ZONE 'Europe/Madrid')::int AS dow,
                       count(*)::int AS n
                FROM message
                WHERE conversation_id = ANY($1)
                GROUP BY dow
                """,
                conv_ids,
            )
            by_dow = [0] * 7
            for dr in dow_rows:
                # Postgres dow: 0=Sun..6=Sat → Monday-first index (dow+6)%7
                by_dow[(dr["dow"] + 6) % 7] = dr["n"]
            kpis_dict["by_dow"] = by_dow

            # ── Marketing heatmap (INBOUND only) — cuándo escriben los CLIENTES ──
            # The casa/número informe doubles as a marketing tool: knowing when
            # leads arrive tells the casa when to advertise / stay online. All
            # of this is inbound-only (direction='in'), scoped to conv_ids, in
            # Europe/Madrid wall-clock. Wrapped so a failure can't break the
            # informe — on any error heat_in/marketing simply stay unset.
            try:
                heat_rows = await conn.fetch(
                    """
                    SELECT extract(dow  from created_at AT TIME ZONE 'Europe/Madrid')::int AS dow,
                           extract(hour from created_at AT TIME ZONE 'Europe/Madrid')::int AS hour,
                           count(*)::int AS n
                    FROM message
                    WHERE conversation_id = ANY($1) AND direction = 'in'
                    GROUP BY dow, hour
                    """,
                    conv_ids,
                )
                # 7×24 grid (rows Mon..Sun, cols hours 0-23) + flat projections.
                heat_in = [[0] * 24 for _ in range(7)]
                by_hour_in = [0] * 24
                by_dow_in = [0] * 7
                for hr in heat_rows:
                    d = hr["dow"]
                    h = hr["hour"]
                    if not (0 <= h <= 23) or not (0 <= d <= 6):
                        continue
                    mon_d = (d + 6) % 7  # Postgres 0=Sun..6=Sat → Mon-first
                    heat_in[mon_d][h] = hr["n"]
                    by_hour_in[h] += hr["n"]
                    by_dow_in[mon_d] += hr["n"]
                kpis_dict["heat_in"] = heat_in
                kpis_dict["by_hour_in"] = by_hour_in
                kpis_dict["by_dow_in"] = by_dow_in

                marketing = _compute_marketing(by_hour_in, by_dow_in)
                if marketing:
                    kpis_dict["marketing"] = marketing
            except Exception:
                logger.exception(
                    "marketing heatmap compute failed for casa %s wa %s",
                    casa_id, wa_number_id,
                )

            # ── First response: per conv min(in) then min(out >= that) ─
            fr_row = await conn.fetchrow(
                """
                WITH first_in AS (
                  SELECT conversation_id, min(created_at) AS t_in
                  FROM message
                  WHERE conversation_id = ANY($1) AND direction = 'in'
                  GROUP BY conversation_id
                ),
                first_out AS (
                  SELECT fi.conversation_id,
                         min(m.created_at) AS t_out, fi.t_in
                  FROM first_in fi
                  JOIN message m ON m.conversation_id = fi.conversation_id
                                AND m.direction = 'out'
                                AND m.created_at >= fi.t_in
                  GROUP BY fi.conversation_id, fi.t_in
                ),
                deltas AS (
                  SELECT extract(epoch from (t_out - t_in)) AS secs
                  FROM first_out
                )
                SELECT
                  coalesce(round(percentile_cont(0.5) WITHIN GROUP (ORDER BY secs))::int, 0) AS fr_p50_sec,
                  coalesce(round(percentile_cont(0.9) WITHIN GROUP (ORDER BY secs))::int, 0) AS fr_p90_sec,
                  coalesce(round(100.0 * count(*) FILTER (WHERE secs < 300)::numeric
                                 / nullif(count(*), 0))::int, 0)                             AS fr_under_5min_pct
                FROM deltas
                """,
                conv_ids,
            )
            if fr_row:
                kpis_dict["first_response"] = {
                    "p50_sec": fr_row["fr_p50_sec"],
                    "p90_sec": fr_row["fr_p90_sec"],
                    "pct_under_5min": fr_row["fr_under_5min_pct"],
                }

            # ── Returning %: contact_id with >=2 total conversations ──
            returning_pct = await conn.fetchval(
                """
                WITH scope AS (
                  SELECT DISTINCT contact_id
                  FROM conversation
                  WHERE id = ANY($1)
                ),
                counts AS (
                  SELECT s.contact_id,
                         (SELECT count(*) FROM conversation c2
                          WHERE c2.contact_id = s.contact_id AND c2.id = ANY($2)) AS total
                  FROM scope s
                )
                SELECT coalesce(round(100.0 * count(*) FILTER (WHERE total >= 2)::numeric
                               / nullif(count(*), 0))::int, 0)
                FROM counts
                """,
                conv_ids,
                conv_ids,
            )
            kpis_dict["returning_pct"] = int(returning_pct or 0)

            # ── Oldest unanswered (hours) — last msg from client ──────
            oldest_unanswered = await conn.fetchval(
                """
                WITH last_msg AS (
                  SELECT DISTINCT ON (conversation_id)
                    conversation_id, direction, created_at
                  FROM message
                  WHERE conversation_id = ANY($1)
                  ORDER BY conversation_id, created_at DESC
                )
                SELECT coalesce(
                  round(extract(epoch from (now() - min(created_at))) / 3600.0)::int, 0)
                FROM last_msg
                WHERE direction = 'in'
                """,
                conv_ids,
            )
            kpis_dict["oldest_unanswered_hours"] = int(oldest_unanswered or 0)

            # ── Money KPIs (Entrega 2) — aggregated by the IA in the SAME call.
            # Stored inside the existing kpis JSONB (no migration, no new
            # columns). .model_dump() keeps list/obj fields JSON-serializable.
            kpis_dict["funnel"] = result.funnel.model_dump()
            kpis_dict["confirmed_bookings"] = result.confirmed_bookings
            kpis_dict["confirmed_rate_pct"] = result.confirmed_rate_pct
            kpis_dict["estimated_revenue_eur"] = result.estimated_revenue_eur
            kpis_dict["revenue_is_estimate"] = result.revenue_is_estimate
            kpis_dict["lost_reasons"] = [r.model_dump() for r in result.lost_reasons]
            kpis_dict["top_chicas"] = [c.model_dump() for c in result.top_chicas]
            kpis_dict["top_services"] = [s.model_dump() for s in result.top_services]
            kpis_dict["upsell_count"] = result.upsell_count
            kpis_dict["upsell_pct"] = result.upsell_pct
            kpis_dict["channel_roi"] = [r.model_dump() for r in result.channel_roi]

            block_cost_usd = skills.compute_cost_usd(block_token_acc)
            await conn.execute(
                """
                INSERT INTO casa_meta_analysis (
                    account_id, wa_number_id, conversations_analyzed,
                    period_start, period_end,
                    summary, patterns, strengths, improvements, client_profile,
                    top_topics, avoided_topics, top_referrals, kpis,
                    claude_cost_usd, claude_tokens_in, claude_tokens_out
                ) VALUES (
                    $1, $2, $3, $4, $5,
                    $6, $7::jsonb, $8::jsonb, $9::jsonb, $10,
                    $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb,
                    $15, $16, $17
                )
                """,
                casa_id, wa_number_id, len(transcripts),
                dates["period_start"], dates["period_end"],
                result.summary,
                json.dumps([]),  # patterns — not produced by the block path
                json.dumps(result.strengths),
                json.dumps(result.improvements),
                result.client_profile,
                json.dumps([t.model_dump() for t in result.top_topics]),
                json.dumps([]),  # avoided_topics — not produced by the block path
                json.dumps([r.model_dump() for r in result.top_referrals]),
                json.dumps(kpis_dict),
                block_cost_usd,
                block_token_acc.get("input", 0),
                block_token_acc.get("output", 0),
            )

            # Alert rows for menor/fraude red flags (no conversation_id — the
            # block path reads many convs at once, so the flag is casa-scoped).
            for f in result.red_flags:
                if f.type in ("menor", "fraude"):
                    await conn.execute(
                        """
                        INSERT INTO alert (type, severity, inbox_id, message)
                        VALUES ('red_flag', 'critical', $1, $2)
                        """,
                        casa_id, f"{f.type}: {f.reason}",
                    )
    except Exception:
        logger.exception("block-analysis save failed for casa %s wa %s",
                         casa_id, wa_number_id)
        if redis:
            await prog.set_progress(redis, pkey, phase="error", pct=100,
                                    message="Error al guardar — revisa logs",
                                    started_at=started)
        return

    if redis:
        await prog.set_progress(redis, pkey, phase="done", pct=100,
                                message="✓ Informe completado", started_at=started)
        scope_suffix = f":wa:{wa_number_id}" if wa_number_id else ""
        await redis.delete(f"casa:{casa_id}{scope_suffix}:meta_running")

    duration_ms = int((time.time() - started) * 1000)
    logger.info(
        '{"event":"block_analysis_done","casa_id":%d,"wa":%s,"convs":%d,"duration_ms":%d}',
        casa_id, wa_number_id, len(transcripts), duration_ms,
    )


async def waha_health_check_job(ctx: dict) -> None:
    """Periodic (every 60s): MONITOR each wa_number's WAHA session, persist the
    phone when WORKING, and raise a badge alert when a paired line drops.

    IMPORTANT — this job NEVER resurrects a session (no start/create/restart/
    delete). Auto-starting un-authed sessions makes NOWEB churn "attempting
    registration…" from a single VPS IP, which WhatsApp punishes by logging out
    the whole cluster — the real cause of the daily de-linking. Starting/pairing
    is human-initiated (the Conectar modal, which sets wa:pairing:{session});
    sessions with valid creds reconnect on their own inside NOWEB. The ONLY WAHA
    write here is a /stop on a session stuck started-but-unauthed, to halt churn.

    Redis keys:
      - wa:laststatus:{wa_id}   → prior status, to ack the alert on the down→up edge
      - wa:pairing:{session}    → operator is actively pairing (set/refreshed by the
                                  Conectar routes) → leave the line alone
    """
    kpi: asyncpg.Pool = ctx["kpi_db"]
    redis = ctx.get("redis")
    s = get_settings()

    async with httpx.AsyncClient(
        base_url=s.waha_api_url,
        headers={"X-Api-Key": s.waha_api_key.get_secret_value()},
        timeout=15.0,
    ) as waha:
        async with kpi.acquire() as conn:
            rows = await conn.fetch(
                "SELECT id, casa_id, session, label, phone FROM wa_number"
            )

        for wa in rows:
            wa_id = wa["id"]
            session = wa["session"]
            k_started   = f"wa:recov:{wa_id}:started"
            k_next_stop = f"wa:recov:{wa_id}:next_stop_at"
            k_next_start= f"wa:recov:{wa_id}:next_start_at"
            k_fails     = f"wa:recov:{wa_id}:fails"
            k_laststatus= f"wa:laststatus:{wa_id}"
            k_pairing   = f"wa:pairing:{session}"

            try:
                info = (await waha.get(f"/api/sessions/{session}")).json()
            except Exception:
                logger.exception("healthcheck: WAHA unreachable for %s", session)
                continue

            status = info.get("status")
            me = info.get("me") or {}
            me_jid = (me.get("id") or "").split("@")[0] or None

            # Remember the prior status so we can detect a WORKING → down DROP
            # (the moment a live line falls) exactly once.
            prev_status = await redis.get(k_laststatus) if redis else None
            if redis:
                await redis.set(k_laststatus, status or "UNKNOWN", ex=7 * 24 * 3600)

            # ── HEALTHY: WORKING → persist phone, clear recovery state ──
            if status == "WORKING":
                if me_jid:
                    async with kpi.acquire() as conn:
                        await conn.execute(
                            "UPDATE wa_number SET phone = $1 WHERE id = $2 AND (phone IS NULL OR phone != $1)",
                            me_jid, wa_id,
                        )
                # Reconnected → clear any open "needs re-pair" alert for THIS line.
                # Run the ack whenever the prior status was NOT a known WORKING —
                # including None (Redis lost k_laststatus, or first tick). If we
                # gated on `prev_status and ...`, a Redis flush between the drop and
                # the recovery would skip the ack forever and leave a phantom badge
                # (wa_needs_pair never ages out). The extra message-LIKE scan only
                # runs on the down→up edge (next tick prev_status becomes WORKING).
                if prev_status != "WORKING":
                    async with kpi.acquire() as conn:
                        await conn.execute(
                            "UPDATE alert SET acknowledged_at = now() "
                            "WHERE type = 'wa_needs_pair' AND acknowledged_at IS NULL "
                            "AND message LIKE $1",
                            f"%[wa:{wa_id}]%",
                        )
                if redis:
                    await redis.delete(k_started, k_next_stop, k_next_start, k_fails)
                continue

            # ── NOT WORKING ─────────────────────────────────────────────────
            # We NEVER resurrect a session here. Repeatedly starting an un-authed
            # session makes NOWEB churn registration attempts from our single IP,
            # which WhatsApp punishes by logging out the whole cluster (the daily
            # de-linking). So: leave a line alone while it's actively being paired,
            # alert once if a previously-paired line dropped, and STOP a line stuck
            # started-but-unauthed so it stops hammering WhatsApp.

            # Purge leftover state from the old auto-recover logic.
            if redis:
                await redis.delete(k_started, k_next_stop, k_next_start, k_fails)

            # Operator actively pairing? (flag set/refreshed by the Conectar routes,
            # short TTL). Leave the line in SCAN_QR to be scanned — don't stop it.
            pairing = bool(await redis.get(k_pairing)) if redis else False
            if pairing:
                continue

            # Previously paired (phone persisted on WORKING) and now down → it lost
            # auth. Alert to RE-VINCULAR (idempotent, badge-visible). Never auto-start.
            if wa["phone"]:
                newly_down = False
                async with kpi.acquire() as conn:
                    exists = await conn.fetchval(
                        "SELECT 1 FROM alert WHERE type = 'wa_needs_pair' "
                        "AND acknowledged_at IS NULL AND message LIKE $1 LIMIT 1",
                        f"%[wa:{wa_id}]%",
                    )
                    if not exists:
                        await conn.execute(
                            "INSERT INTO alert (type, severity, inbox_id, message) "
                            "VALUES ('wa_needs_pair', 'critical', $1, $2)",
                            wa["casa_id"],
                            f"WA '{wa['label']}' ({session}) se desconectó — hay que "
                            f"RE-VINCULAR (escanea el QR o pide el código en Conexiones). [wa:{wa_id}]",
                        )
                        newly_down = True
                # One-shot Telegram heads-up the moment a live line drops — fired
                # OUTSIDE the DB connection (the HTTP call must not hold a pooled
                # conn) and only on the fresh insert (once per outage, not every
                # tick). push_alert is fail-soft: no-op when Telegram is unset,
                # never raises.
                if newly_down:
                    logger.warning(
                        "healthcheck: %s (%s) down (status=%s) — needs re-pair",
                        wa["label"], session, status,
                    )
                    await push_alert(
                        f"⚠️ WhatsApp caído\n\n"
                        f"Línea: {wa['label']} ({session})\n"
                        f"Necesita RE-VINCULAR: panel → Conexiones → Conectar → "
                        f"código de 8 dígitos."
                    )

            # HALT THE CHURN: a line sitting in SCAN_QR_CODE (actively soliciting a
            # pairing/registration) that nobody is pairing is just hammering WhatsApp
            # from our IP. Stop it (one best-effort call); it stays stopped until a
            # human opens Conectar. This is THE fix for the daily mass de-linking.
            # NOTE: only SCAN_QR_CODE — NOT STARTING. An already-authed session
            # passes through STARTING with `me` not yet populated while it restores
            # its creds (e.g. right after the mandatory `restart waha` on deploy);
            # stopping it there would kill a live line that would have reconnected.
            if status == "SCAN_QR_CODE" and not me_jid:
                try:
                    await waha.post(f"/api/sessions/{session}/stop")
                    logger.info(
                        "healthcheck: stopped idle un-authed session %s to halt churn",
                        session,
                    )
                except Exception:
                    logger.warning("healthcheck: stop failed for %s", session, exc_info=True)
            # STARTING / STOPPED / FAILED / UNKNOWN → leave as-is (never auto-start).
            continue


async def block_analyze_sweep_job(ctx: dict) -> None:
    """CRON (daily): refresh EACH casa's informe so /metricas + /informes don't go
    stale. block_analyze is on-demand only otherwise, and list_latest_meta_per_casa
    filters by run_at within the period — so an un-clicked casa silently DROPS OUT
    of the aggregate. This enqueues ONE block_analyze per casa, skipping casas with
    an in-flight informe (reuses the analysis_ops meta running flag), staggered to
    spread the Claude load. Cheap here (find + enqueue only; the LLM runs in the
    per-casa job). Wrapped so a sweep failure never tumbles the cron loop."""
    kpi: asyncpg.Pool = ctx["kpi_db"]
    arq = ctx.get("arq")
    redis = ctx.get("redis")
    if arq is None or redis is None:
        logger.warning("block_sweep: missing arq/redis handle — skip")
        return
    try:
        casas = await queries.list_casas(kpi)
    except Exception:
        logger.exception("block_sweep: list_casas query failed")
        return
    enqueued = 0
    for i, casa in enumerate(casas):
        cid = casa.account_id
        try:
            # Same casa-wide SETNX running flag the manual trigger uses
            # (analysis_ops._meta_running_key(cid, None)) so a daily run never
            # collides with an in-flight manual informe; nx → also dedups ticks.
            if not await redis.set(f"casa:{cid}:meta_running", "1", nx=True, ex=900):
                continue
            # 168h window / 200 convs = the manual default; stagger 30s apart.
            await arq.enqueue_job(
                "block_analyze_casa_job",
                cid, None, 168, 200, None, None,
                _defer_by=i * 30,
            )
            enqueued += 1
        except Exception:
            logger.exception("block_sweep: enqueue failed casa=%s", cid)
    logger.info("block_sweep: enqueued %d casa informe(s)", enqueued)


async def harvest_style_examples_job(ctx: dict) -> None:
    """CRON (daily): harvest real HUMAN receptionist replies per casa into
    `casa_style_example` (Wave 2 — Sara learns from how the team replies). Replies
    the encargada REPEATS (>= STYLE_AUTO_APPROVE_MIN times) auto-approve so the bot
    learns them with no manual review; one-offs land as 'pending' for the super-admin
    (/ajustes/estilo). Pure read+upsert (no LLM, no sends, no sleeps), each casa
    fault-isolated. Sanitization/classification lives in app.agent.style_harvest."""
    kpi: asyncpg.Pool = ctx["kpi_db"]
    try:
        casas = await queries.list_casas(kpi)
    except Exception:
        logger.exception("style_harvest: list_casas query failed")
        return
    total = 0
    for casa in casas:
        try:
            total += await style_harvest.harvest_casa(kpi, casa.account_id)
        except Exception:
            logger.exception("style_harvest: harvest failed casa=%s", casa.account_id)
    logger.info("style_harvest: inserted %d new style-example candidate(s)", total)


_AUTO_MERGE_MIN_CONFIDENCE = 0.85  # unattended: only merge when the IA is very sure


async def auto_merge_sweep_job(ctx: dict) -> None:
    """CRON (~every 10 min): AUTOMATICALLY merge the clear @c.us/@lid duplicate of the
    same client that the webhook flagged as `merge_suggestion`. Two independent gates
    guard the destructive (but now REVERSIBLE) merge, and BOTH must agree:

      1. DETERMINISTIC structural match — the single complementary sibling on the
         SAME WhatsApp line (queries.find_structural_merge_sibling). This alone
         rules out fusing two unrelated clients.
      2. IA CONFIRMS that specific pair at high confidence (>= the threshold).

    The merge itself snapshots the source into merge_event (undo), preserves the
    phone, and acks the source's alerts atomically — so the sweep never acks a
    suggestion it didn't actually merge. Runs in the WORKER (never from the
    webhook); a Redis flag bounds the Claude cost to one confirm per conv / 6h."""
    from app.agent import rate_limit
    from app.dedup import confirm_same_client

    kpi: asyncpg.Pool = ctx["kpi_db"]
    redis = ctx.get("redis")
    arq = ctx.get("arq")

    async with kpi.acquire() as conn:
        rows = await conn.fetch(
            "SELECT conversation_id FROM alert "
            "WHERE type = 'merge_suggestion' AND acknowledged_at IS NULL "
            "AND conversation_id IS NOT NULL "
            "ORDER BY created_at DESC LIMIT 10"
        )

    for r in rows:
        conv_id = r["conversation_id"]
        # Don't re-run the IA on the same conversation more than once per 6h.
        if redis and not await redis.set(f"merge:checked:{conv_id}", "1", nx=True, ex=6 * 3600):
            continue
        merged = False
        target_id = None
        try:
            # Gate 1: deterministic — the single complementary sibling on this line.
            sibling_id = await queries.find_structural_merge_sibling(kpi, conv_id)
            if not sibling_id:
                continue  # no clean structural duplicate → leave the suggestion
            # Gate 2: IA confirms THAT exact pair (and returns THAT id).
            result = await confirm_same_client(kpi, conv_id, sibling_id)
            if (not result or result.best_match_id != sibling_id
                    or result.confidence < _AUTO_MERGE_MIN_CONFIDENCE):
                continue  # not confident → leave the suggestion for a human
            # Serialize against the reply pipeline: NEVER merge (and delete) a
            # conversation that an auto_reply job is working on — that would drop or
            # crash the in-flight reply (message.conversation_id is FK ON DELETE
            # CASCADE). Take the SAME per-conversation lock auto_reply uses, for BOTH
            # convs; if either is held, skip this pair and retry next tick.
            if not await rate_limit.acquire_conv_lock(redis, conv_id):
                continue
            try:
                if not await rate_limit.acquire_conv_lock(redis, sibling_id):
                    continue
                try:
                    await queries.merge_conversation_into(
                        kpi, conv_id, sibling_id, triggered_by="auto",
                        confidence=result.confidence, reasoning=result.reasoning,
                    )
                    merged = True
                    target_id = sibling_id
                finally:
                    await rate_limit.release_conv_lock(redis, sibling_id)
            finally:
                await rate_limit.release_conv_lock(redis, conv_id)
        except ValueError:
            continue  # stale / invalid pair → leave it
        except Exception:
            logger.exception("auto-merge sweep: failed for conv %s", conv_id)
            continue

        if merged:
            # The client's incoming turn moved into the survivor. The reply job that
            # was enqueued for the (now deleted) source will no-op, so schedule one
            # for the survivor — auto_reply_job re-checks mode + whether a reply is
            # actually needed, so this is a cheap no-op when it isn't.
            if arq is not None:
                try:
                    await arq.enqueue_job("auto_reply_job", target_id, _defer_by=8)
                except Exception:
                    logger.warning(
                        "auto-merge sweep: could not enqueue reply for %s", target_id, exc_info=True
                    )
            logger.info(
                "auto-merge sweep: merged conv %s → %s (conf %.2f)",
                conv_id, target_id, result.confidence,
            )


class WorkerSettings:
    functions = [
        block_analyze_casa_job,
        auto_reply_job,
        followup_send_job,  # per-conversation abandoned-quote nudge (normal job)
        website_sync_job,  # also enqueueable on-demand for a one-off sync
    ]
    cron_jobs = [
        cron(waha_health_check_job, minute=set(range(60))),  # every minute
        # Mirror each WEB-mode casa's LIVE website (config + girls) into the DB every
        # ~20 min. Casas in "Backoffice/manual" mode (Ficha del día) are SKIPPED —
        # the panel is their source of truth; the operator imports those on demand
        # via the panel's "Sincronizar desde la web" button (website_sync.sync_all).
        cron(website_sync_job, minute={0, 20, 40}),
        # Find abandoned quotes (Sara quoted a price, client went silent) and
        # enqueue ONE re-engagement nudge each. Cheap: find + enqueue only, no
        # sends/LLM/sleeps in the cron (followup_sweep_job).
        cron(followup_sweep_job, minute={5, 15, 25, 35, 45, 55}),
        # Daily informe refresh (~05:00 UTC ≈ 07:00 Madrid summer / 06:00 winter),
        # off-peak for nightlife casas — keeps /metricas + /informes fresh so
        # un-clicked casas don't drop out of the aggregate (block_analyze_sweep_job).
        cron(block_analyze_sweep_job, hour={5}, minute={0}),
        # Daily harvest of real human-receptionist replies into style-example
        # candidates (~04:30 UTC). A super-admin approves them in /ajustes/estilo;
        # approved ones are injected into Sara's prompt (most relevant to the
        # client's message first) so she learns how the team answers each situation.
        cron(harvest_style_examples_job, hour={4}, minute={30}),
        # Auto-merge duplicate conversations of the same client (@c.us vs @lid),
        # every 10 min, IA-gated at high confidence. Restores the "it merges by
        # itself" behaviour from the Evolution era, safely.
        cron(auto_merge_sweep_job, minute={2, 12, 22, 32, 42, 52}),
    ]
    on_startup = startup
    on_shutdown = shutdown
    max_jobs = 10
    job_timeout = 900  # 15 min — block-analysis reads transcripts in one Claude call (~90-180s); wide margin
    redis_settings = RedisSettings.from_dsn(get_settings().redis_url)
