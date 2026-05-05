"""arq worker — consumes conversation analysis jobs from Redis.

Reads messages from the KPI-owned `message` table (populated by WAHA webhook).

Flow per job:
  1. Fetch messages for this conversation (kpi.message).
  2. Fan out 5 Claude Haiku calls in parallel.
  3. UPSERT result into kpi.analysis.
"""

from __future__ import annotations

import asyncio
import json
import logging

import asyncpg
import httpx
from arq import cron
from arq.connections import RedisSettings

from app.analyzer import skills
from app.analyzer.skills import Message
from app.settings import get_settings

logger = logging.getLogger("analyzer.worker")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


async def startup(ctx: dict) -> None:
    import redis.asyncio as redis_async
    from arq import create_pool
    s = get_settings()
    ctx["kpi_db"] = await asyncpg.create_pool(dsn=s.database_url, min_size=1, max_size=5)
    ctx["redis"] = redis_async.from_url(s.redis_url, decode_responses=True)
    ctx["arq_pool"] = await create_pool(RedisSettings.from_dsn(s.redis_url))
    logger.info("analyzer worker ready")


async def shutdown(ctx: dict) -> None:
    await ctx["kpi_db"].close()
    if "redis" in ctx:
        await ctx["redis"].aclose()
    if "arq_pool" in ctx:
        await ctx["arq_pool"].close()
    logger.info("analyzer worker shut down")


async def analyze_conversation_job(ctx: dict, conversation_id: int) -> None:
    """Analyze one conversation end-to-end."""
    kpi: asyncpg.Pool = ctx["kpi_db"]

    async with kpi.acquire() as conn:
        header = await conn.fetchrow(
            "SELECT casa_id, wa_number_id FROM conversation WHERE id = $1",
            conversation_id,
        )
        if not header:
            logger.warning("conversation %s not found — skip", conversation_id)
            return

        rows = await conn.fetch(
            """
            SELECT body, direction,
                   extract(epoch from created_at)::int AS ts
            FROM message
            WHERE conversation_id = $1
            ORDER BY created_at ASC
            """,
            conversation_id,
        )

    if not rows:
        logger.info("conversation %s has no messages — skip", conversation_id)
        return

    msgs = [
        Message(
            ts=r["ts"],
            role="cliente" if r["direction"] == "in" else "mamai",
            content=(r["body"] or "")[:1000],
        )
        for r in rows
    ]

    try:
        (
            mood, rt, treat, conv, flags, coaching,
            intent, next_action, escalation,
        ) = await asyncio.gather(
            skills.analyze_mood(msgs),
            skills.analyze_response_time(msgs),
            skills.analyze_treatment(msgs),
            skills.analyze_conversion_intent(msgs),
            skills.detect_red_flags(msgs),
            skills.analyze_coaching(msgs),
            skills.classify_intent(msgs),
            skills.recommend_next_action(msgs),
            skills.evaluate_escalation(msgs),
        )
    except Exception:
        logger.exception("analysis failed for conversation %s", conversation_id)
        raise

    casa_id = header["casa_id"]
    wa_number_id = header["wa_number_id"]
    async with kpi.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO analysis (
                conversation_id, account_id, inbox_id, wa_number_id,
                mood_label, mood_score, mood_reasoning,
                rt_p50, rt_p90, rt_max,
                treat_carinoso, treat_profesional, treat_vendedor, treat_seco,
                conv_probability,
                red_flags, coaching,
                intent, next_action, escalation
            ) VALUES (
                $1, $2, $3, $4,
                $5, $6, $7,
                $8, $9, $10,
                $11, $12, $13, $14,
                $15,
                $16::jsonb, $17::jsonb,
                $18::jsonb, $19::jsonb, $20::jsonb
            )
            ON CONFLICT (conversation_id) DO UPDATE SET
                analyzed_at = now(),
                wa_number_id = EXCLUDED.wa_number_id,
                mood_label = EXCLUDED.mood_label,
                mood_score = EXCLUDED.mood_score,
                mood_reasoning = EXCLUDED.mood_reasoning,
                rt_p50 = EXCLUDED.rt_p50,
                rt_p90 = EXCLUDED.rt_p90,
                rt_max = EXCLUDED.rt_max,
                treat_carinoso = EXCLUDED.treat_carinoso,
                treat_profesional = EXCLUDED.treat_profesional,
                treat_vendedor = EXCLUDED.treat_vendedor,
                treat_seco = EXCLUDED.treat_seco,
                conv_probability = EXCLUDED.conv_probability,
                red_flags = EXCLUDED.red_flags,
                coaching = EXCLUDED.coaching,
                intent = EXCLUDED.intent,
                next_action = EXCLUDED.next_action,
                escalation = EXCLUDED.escalation
            """,
            conversation_id,
            casa_id,
            wa_number_id or casa_id,  # legacy inbox_id kept for old indexes
            wa_number_id,
            mood.label, mood.score, mood.reasoning,
            rt.p50_ms, rt.p90_ms, rt.max_ms,
            treat.carinoso, treat.profesional, treat.vendedor, treat.seco,
            conv.probability,
            json.dumps([f.model_dump() for f in flags]),
            json.dumps(coaching.model_dump()),
            json.dumps(intent.model_dump()),
            json.dumps(next_action.model_dump()),
            json.dumps(escalation.model_dump()),
        )

        for f in flags:
            if f.type in ("menor", "fraude"):
                await conn.execute(
                    """
                    INSERT INTO alert (type, severity, conversation_id, inbox_id, message)
                    VALUES ('red_flag', 'critical', $1, $2, $3)
                    """,
                    conversation_id, casa_id,
                    f"{f.type}: {f.reason}",
                )

        if rt.p90_ms > 30 * 60 * 1000:
            await conn.execute(
                """
                INSERT INTO alert (type, severity, conversation_id, inbox_id, message)
                VALUES ('slow_response', 'warning', $1, $2, $3)
                """,
                conversation_id, casa_id,
                f"Tiempo respuesta p90 = {rt.p90_ms // 60000} min",
            )

        # Escalation alert — admin should take over. Only for medium/high severity
        # to avoid spam. Idempotent per conversation (unack'd copy = skip).
        if escalation.should_escalate and escalation.severity in ("medium", "high"):
            already = await conn.fetchval(
                """
                SELECT 1 FROM alert
                WHERE type='escalation' AND conversation_id=$1 AND acknowledged_at IS NULL
                LIMIT 1
                """,
                conversation_id,
            )
            if not already:
                await conn.execute(
                    """
                    INSERT INTO alert (type, severity, conversation_id, inbox_id, message)
                    VALUES ('escalation', $1, $2, $3, $4)
                    """,
                    "critical" if escalation.severity == "high" else "warning",
                    conversation_id, casa_id,
                    f"Escalation: {escalation.reason or 'admin needed'}",
                )

    logger.info(
        "✓ analyzed conv %s — mood=%s conv=%.2f flags=%d",
        conversation_id, mood.label, conv.probability, len(flags),
    )


async def meta_analyze_casa_job(ctx: dict, casa_id: int, wa_number_id: int | None = None) -> None:
    """Meta-analyze a casa using last 50 analyzed conversations.

    If `wa_number_id` is provided, restrict the sample to that WhatsApp only
    — useful for per-WA insights when a casa has multiple numbers (oficial /
    secundario / marketing etc.).
    """
    import time
    from app.analyzer.meta_analysis import ConvSummary, run_meta_analysis

    kpi: asyncpg.Pool = ctx["kpi_db"]
    started = time.time()

    async with kpi.acquire() as conn:
        name_row = await conn.fetchrow("SELECT name FROM casa WHERE id = $1", casa_id)
        if not name_row:
            logger.warning("casa %s not found", casa_id)
            return
        casa_name = name_row["name"]

        wa_label = None
        if wa_number_id is not None:
            wa_row = await conn.fetchrow(
                "SELECT label FROM wa_number WHERE id = $1", wa_number_id
            )
            wa_label = wa_row["label"] if wa_row else None

        wa_filter = "AND wa_number_id = $2" if wa_number_id is not None else ""
        params = [casa_id] + ([wa_number_id] if wa_number_id is not None else [])
        rows = await conn.fetch(
            f"""
            SELECT conversation_id, mood_label, mood_score,
                   treat_carinoso, treat_profesional, treat_vendedor, treat_seco,
                   conv_probability
            FROM analysis
            WHERE account_id = $1 {wa_filter}
            ORDER BY analyzed_at DESC
            LIMIT 50
            """,
            *params,
        )

    if len(rows) < 10:
        logger.warning("casa %s has only %d analyzed convs, skipping", casa_id, len(rows))
        return

    conv_ids = [r["conversation_id"] for r in rows]
    async with kpi.acquire() as conn:
        first_msgs = await conn.fetch(
            """
            SELECT DISTINCT ON (conversation_id) conversation_id, body
            FROM message
            WHERE conversation_id = ANY($1) AND direction = 'in'
            ORDER BY conversation_id, created_at ASC
            """,
            conv_ids,
        )
    first_line_map = {r["conversation_id"]: (r["body"] or "") for r in first_msgs}

    summaries = [
        ConvSummary(
            conv_id=r["conversation_id"],
            mood=r["mood_label"],
            mood_score=r["mood_score"],
            treat_carinoso=r["treat_carinoso"],
            treat_profesional=r["treat_profesional"],
            treat_vendedor=r["treat_vendedor"],
            treat_seco=r["treat_seco"],
            conv_probability=float(r["conv_probability"]),
            first_client_line=first_line_map.get(r["conversation_id"], "")[:100],
        )
        for r in rows
    ]

    # Enrich casa_name when scoped to a specific WA
    meta_casa_name = f"{casa_name} · {wa_label}" if wa_label else casa_name

    try:
        result = await run_meta_analysis(meta_casa_name, summaries)
    except Exception:
        logger.exception("meta-analysis call failed for casa %s wa %s", casa_id, wa_number_id)
        raise

    async with kpi.acquire() as conn:
        dates = await conn.fetchrow(
            """
            SELECT min(analyzed_at) AS period_start, max(analyzed_at) AS period_end
            FROM analysis
            WHERE conversation_id = ANY($1)
            """,
            conv_ids,
        )

        await conn.execute(
            """
            INSERT INTO casa_meta_analysis (
                account_id, wa_number_id, conversations_analyzed,
                period_start, period_end,
                summary, patterns, strengths, improvements, client_profile
            ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10)
            """,
            casa_id, wa_number_id, len(summaries),
            dates["period_start"], dates["period_end"],
            result.summary,
            json.dumps([p.model_dump() for p in result.patterns]),
            json.dumps(result.strengths),
            json.dumps(result.improvements),
            result.client_profile,
        )

    redis = ctx.get("redis")
    if redis:
        await redis.delete(f"casa:{casa_id}:meta_running")

    duration_ms = int((time.time() - started) * 1000)
    logger.info(
        '{"event":"meta_analysis_done","casa_id":%d,"duration_ms":%d,"patterns":%d}',
        casa_id, duration_ms, len(result.patterns),
    )


async def waha_health_check_job(ctx: dict) -> None:
    """Periodic (every 60s): iterate over wa_number, check WAHA session
    status, persist phone when WORKING, and auto-recover FAILED/STOPPED.

    Stateful recovery via Redis (no long asyncio.sleep):
      - wa:recov:{wa_id}:started      → ISO ts of first failure
      - wa:recov:{wa_id}:next_stop_at → earliest next /stop attempt
      - wa:recov:{wa_id}:next_start_at→ earliest next /start attempt
      - wa:recov:{wa_id}:fails        → consecutive failures (circuit breaker)

    Each cron run does at most ONE WAHA call per WA (stop OR start OR delete).
    """
    import time
    from datetime import datetime, timezone

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
                "SELECT id, casa_id, session, label FROM wa_number"
            )

        for wa in rows:
            wa_id = wa["id"]
            session = wa["session"]
            k_started   = f"wa:recov:{wa_id}:started"
            k_next_stop = f"wa:recov:{wa_id}:next_stop_at"
            k_next_start= f"wa:recov:{wa_id}:next_start_at"
            k_fails     = f"wa:recov:{wa_id}:fails"

            try:
                info = (await waha.get(f"/api/sessions/{session}")).json()
            except Exception:
                logger.exception("healthcheck: WAHA unreachable for %s", session)
                continue

            status = info.get("status")
            me = info.get("me") or {}
            me_jid = (me.get("id") or "").split("@")[0] or None

            # ── HEALTHY: WORKING → persist phone, clear recovery state ──
            if status == "WORKING":
                if me_jid:
                    async with kpi.acquire() as conn:
                        await conn.execute(
                            "UPDATE wa_number SET phone = $1 WHERE id = $2 AND (phone IS NULL OR phone != $1)",
                            me_jid, wa_id,
                        )
                if redis:
                    await redis.delete(k_started, k_next_stop, k_next_start, k_fails)
                continue

            # ── UNHEALTHY: stateful recovery ──
            now = time.time()
            started_raw = await redis.get(k_started) if redis else None
            if started_raw:
                try:
                    downtime_min = (now - float(started_raw)) / 60
                except (TypeError, ValueError):
                    downtime_min = 0.0
            else:
                if redis:
                    await redis.set(k_started, str(now))
                downtime_min = 0.0

            # Circuit breaker: stop retrying after 60 consecutive failures
            fails = int(await redis.get(k_fails) or 0) if redis else 0
            if fails >= 60:
                # Alert once per hour while circuit is open, but don't hammer WAHA
                if fails % 60 == 0:
                    logger.error(
                        "healthcheck: circuit OPEN for wa %s (%s) — %d fails, giving up auto-recovery",
                        wa["label"], session, fails,
                    )
                if redis:
                    await redis.incr(k_fails)
                continue

            # Throttled alert (≤1/10min)
            async with kpi.acquire() as conn:
                recent_alert = await conn.fetchval(
                    """
                    SELECT 1 FROM alert
                    WHERE type = 'wa_disconnected' AND inbox_id = $1
                      AND created_at > now() - interval '10 minutes'
                    LIMIT 1
                    """,
                    wa["casa_id"],
                )
                if not recent_alert:
                    await conn.execute(
                        """
                        INSERT INTO alert (type, severity, inbox_id, message)
                        VALUES ('wa_disconnected', 'warning', $1, $2)
                        """,
                        wa["casa_id"],
                        f"WA '{wa['label']}' ({session}) status={status} "
                        f"(downtime {int(downtime_min)}min), auto-recovering",
                    )

            # Pick action based on stage + schedule
            next_stop  = float(await redis.get(k_next_stop)  or 0) if redis else 0
            next_start = float(await redis.get(k_next_start) or 0) if redis else 0

            async def _bump_fail():
                if redis:
                    await redis.incr(k_fails)

            try:
                if downtime_min < 15:
                    # Stage 1-2: gentle stop → wait → start. Driven by schedule.
                    if status == "FAILED" and now >= next_stop:
                        try:
                            await waha.post(f"/api/sessions/{session}/stop")
                        except Exception:
                            pass
                        wait_secs = 5 if downtime_min < 2 else 30
                        if redis:
                            await redis.set(k_next_start, str(now + wait_secs))
                            await redis.set(k_next_stop, str(now + 600))  # avoid re-stop loop
                    elif now >= next_start:
                        try:
                            await waha.post(f"/api/sessions/{session}/start")
                        except Exception:
                            await _bump_fail()
                        if redis:
                            await redis.set(k_next_start, str(now + 60))  # try again next cron if still failing
                            await redis.set(k_fails, str(fails + 1))
                else:
                    # Stage 3 (>15min): delete+recreate. LOSES auth → QR rescan needed.
                    async with kpi.acquire() as conn:
                        await conn.execute(
                            """
                            INSERT INTO alert (type, severity, inbox_id, message)
                            VALUES ('wa_needs_qr', 'critical', $1, $2)
                            """,
                            wa["casa_id"],
                            f"WA '{wa['label']}' lleva >15min en FAILED. "
                            f"Auto-reset — SE REQUIERE ESCANEAR QR de nuevo.",
                        )
                    try:
                        await waha.delete(f"/api/sessions/{session}")
                    except Exception:
                        pass
                    if redis:
                        # Defer create to next cron tick (no sleep here)
                        await redis.set(k_next_start, str(now + 10))
                        await redis.delete(k_started)  # reset window after nuke
                        await redis.set(k_fails, "0")
            except Exception:
                logger.exception("auto-restart step failed for %s", session)
                await _bump_fail()


AUTO_MERGE_CONFIDENCE_THRESHOLD = 0.85


async def auto_merge_job(ctx: dict, source_id: int, sibling_id: int) -> None:
    """Try to auto-merge a one-sided conversation pair without admin gate.

    Called from the webhook when a `merge_suggestion` alert is created.
    Behaviour:
      - Loads recent messages from both convs.
      - Asks Claude `detect_same_client` to confirm.
      - If confidence >= AUTO_MERGE_CONFIDENCE_THRESHOLD, executes the merge
        SQL and acknowledges the merge_suggestion alert.
      - Otherwise leaves the suggestion in place for manual review.

    Idempotent: re-checks both convs exist and the casa matches before merging.
    """
    if source_id == sibling_id:
        return
    kpi: asyncpg.Pool = ctx["kpi_db"]

    async with kpi.acquire() as conn:
        src = await conn.fetchrow(
            "SELECT id, casa_id, contact_id FROM conversation WHERE id = $1",
            source_id,
        )
        sib = await conn.fetchrow(
            "SELECT id, casa_id, contact_id FROM conversation WHERE id = $1",
            sibling_id,
        )
        if not src or not sib:
            logger.info("auto_merge: convs missing src=%s sib=%s — skip", source_id, sibling_id)
            return
        if src["casa_id"] != sib["casa_id"]:
            logger.info("auto_merge: casa mismatch — skip")
            return

        src_msgs = await conn.fetch(
            """
            SELECT body, direction, extract(epoch from created_at)::int AS ts
            FROM message WHERE conversation_id = $1
            ORDER BY created_at ASC LIMIT 25
            """,
            source_id,
        )
        sib_msgs = await conn.fetch(
            """
            SELECT body, direction, extract(epoch from created_at)::int AS ts
            FROM message WHERE conversation_id = $1
            ORDER BY created_at ASC LIMIT 25
            """,
            sibling_id,
        )
        sib_label_row = await conn.fetchrow(
            """
            SELECT ct.name, ct.phone, ct.waha_jid
            FROM conversation c JOIN contact ct ON ct.id = c.contact_id
            WHERE c.id = $1
            """,
            sibling_id,
        )

    if not src_msgs or not sib_msgs:
        return

    target_msgs = [
        skills.Message(
            ts=r["ts"],
            role="cliente" if r["direction"] == "in" else "mamai",
            content=(r["body"] or "")[:200],
        )
        for r in src_msgs
    ]
    sib_label = (
        sib_label_row["name"]
        or sib_label_row["phone"]
        or ((sib_label_row["waha_jid"] or "")[:24] + "…")
    )
    candidates = [skills.SiblingConvo(
        conv_id=sibling_id,
        label=sib_label,
        messages=[skills.Message(
            ts=r["ts"],
            role="cliente" if r["direction"] == "in" else "mamai",
            content=(r["body"] or "")[:200],
        ) for r in sib_msgs],
    )]

    try:
        result = await skills.detect_same_client(target_msgs, f"conv {source_id}", candidates)
    except Exception:
        logger.exception("auto_merge: IA call failed src=%s sib=%s", source_id, sibling_id)
        return

    if (
        result.best_match_id != sibling_id
        or result.confidence < AUTO_MERGE_CONFIDENCE_THRESHOLD
    ):
        logger.info(
            "auto_merge: not confident enough src=%s sib=%s match=%s conf=%.2f — leaving suggestion",
            source_id, sibling_id, result.best_match_id, result.confidence,
        )
        return

    # Confidence high enough — perform the merge atomically with audit trail
    # for undo. Same shape as the manual merge in routes/conversation.py.
    async with kpi.acquire() as conn:
        async with conn.transaction():
            src_full = await conn.fetchrow(
                """
                SELECT id, casa_id, wa_number_id, contact_id, status, unread_count
                FROM conversation WHERE id = $1
                """,
                source_id,
            )
            still_sib = await conn.fetchval(
                "SELECT 1 FROM conversation WHERE id = $1", sibling_id,
            )
            if not src_full or not still_sib:
                logger.info("auto_merge: race — one conv gone, abort")
                return

            contact = await conn.fetchrow(
                "SELECT id, waha_jid, name, phone, created_at FROM contact WHERE id = $1",
                src_full["contact_id"],
            )
            contact_snapshot = {
                "id": contact["id"],
                "waha_jid": contact["waha_jid"],
                "name": contact["name"],
                "phone": contact["phone"],
                "created_at": contact["created_at"].isoformat() if contact["created_at"] else None,
            } if contact else {}

            # Tag messages with origin BEFORE moving (allows undo to find them).
            await conn.execute(
                "UPDATE message SET merged_from_conv_id = $1 "
                "WHERE conversation_id = $1 AND merged_from_conv_id IS NULL",
                source_id,
            )
            moved = await conn.fetchval(
                "SELECT count(*) FROM message WHERE conversation_id = $1",
                source_id,
            ) or 0

            await conn.execute(
                "UPDATE message SET conversation_id = $1 WHERE conversation_id = $2",
                sibling_id, source_id,
            )
            await conn.execute(
                """
                UPDATE conversation SET
                    last_message_at = (
                        SELECT max(created_at) FROM message WHERE conversation_id = $1
                    ),
                    unread_count = unread_count + (
                        SELECT unread_count FROM conversation WHERE id = $2
                    ),
                    updated_at = now()
                WHERE id = $1
                """,
                sibling_id, source_id,
            )

            await conn.execute(
                """
                INSERT INTO merge_event (
                    target_conv_id, source_conv_id,
                    source_casa_id, source_wa_number_id, source_contact_id,
                    source_contact_snapshot, source_status, source_unread_count,
                    messages_moved, triggered_by, confidence, reasoning
                ) VALUES (
                    $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, 'auto', $10, $11
                )
                """,
                sibling_id, source_id,
                src_full["casa_id"], src_full["wa_number_id"], src_full["contact_id"],
                json.dumps(contact_snapshot), src_full["status"], src_full["unread_count"],
                int(moved), float(result.confidence), result.reasoning,
            )

            await conn.execute("DELETE FROM conversation WHERE id = $1", source_id)
            await conn.execute(
                """
                DELETE FROM contact c
                WHERE c.id = $1
                  AND NOT EXISTS (SELECT 1 FROM conversation WHERE contact_id = c.id)
                """,
                src_full["contact_id"],
            )
            # Acknowledge the suggestion alert(s) so admin doesn't see stale prompts
            await conn.execute(
                """
                UPDATE alert SET acknowledged_at = now()
                WHERE type = 'merge_suggestion'
                  AND conversation_id IN ($1, $2)
                  AND acknowledged_at IS NULL
                """,
                source_id, sibling_id,
            )

    logger.info(
        "auto_merge: merged conv %s → %s (confidence %.2f) — %s",
        source_id, sibling_id, result.confidence, result.reasoning,
    )

    # Re-trigger analysis on the merged conv since it now has both directions.
    try:
        arq_pool = ctx.get("arq_pool")
        if arq_pool is not None:
            await arq_pool.enqueue_job("analyze_conversation_job", sibling_id, _defer_by=3)
    except Exception:
        logger.warning("auto_merge: could not enqueue re-analysis", exc_info=True)


async def analyze_conversations_bulk_job(ctx: dict, casa_id: int) -> None:
    """Analyze all unanalyzed resolved convs for a casa."""
    from app.queries import list_unanalyzed_conversation_ids

    kpi: asyncpg.Pool = ctx["kpi_db"]
    ids = await list_unanalyzed_conversation_ids(kpi, casa_id, limit=500)
    logger.info("bulk analyze casa %s → %d unanalyzed convs", casa_id, len(ids))

    for conv_id in ids:
        try:
            await analyze_conversation_job(ctx, conv_id)
        except Exception:
            logger.exception("failed analyzing conv %s during bulk", conv_id)


class WorkerSettings:
    functions = [
        analyze_conversation_job,
        meta_analyze_casa_job,
        analyze_conversations_bulk_job,
        auto_merge_job,
    ]
    cron_jobs = [cron(waha_health_check_job, minute=set(range(60)))]  # every minute
    on_startup = startup
    on_shutdown = shutdown
    max_jobs = 10
    job_timeout = 300
    redis_settings = RedisSettings.from_dsn(get_settings().redis_url)
