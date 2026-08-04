#!/usr/bin/env python3
"""One-off backfill: drain the PRE-EXISTING pile of `merge_suggestion` alerts through
the exact same two gates the auto-merge cron uses, so the old duplicates get cleaned
up the same safe, reversible way the live sweep does — just all at once instead of 10
per tick.

    Gate 1  deterministic  queries.find_structural_merge_sibling  (single
            complementary @c.us/@lid sibling on the SAME WhatsApp line)
    Gate 2  IA confirm     dedup.confirm_same_client >= --min-confidence (default 0.85)

Both must agree. The merge itself snapshots the source into `merge_event` (undo),
preserves the phone, and acks the source's alerts atomically — identical to the cron.

DRY-RUN by default: makes the IA calls and reports exactly how many WOULD merge and why
the rest are left, but writes NOTHING. Add --execute to actually merge.

Run inside the kpi-worker container (has DATABASE_URL / ANTHROPIC_API_KEY / REDIS_URL and
the `app` package):

    docker compose cp scripts/backfill_merges.py kpi-worker:/tmp/backfill_merges.py
    docker compose exec -u root -T kpi-worker python /tmp/backfill_merges.py            # dry-run
    docker compose exec -u root -T kpi-worker python /tmp/backfill_merges.py --execute  # do it

Options: --limit N (cap how many to examine), --min-confidence F (default 0.85),
--verbose (print each decision).
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys

# This is meant to be copied into the container and run as `python /tmp/…`, which
# puts only /tmp on sys.path. The app package lives at the container WORKDIR (/app),
# so add it explicitly before importing `app`.
sys.path.insert(0, os.environ.get("APP_ROOT", "/app"))

import asyncpg  # noqa: E402

from app import queries  # noqa: E402
from app.agent import rate_limit  # noqa: E402
from app.dedup import confirm_same_client  # noqa: E402

logger = logging.getLogger("backfill_merges")

_DEFAULT_MIN_CONF = 0.85
_IA_THROTTLE_S = 0.15  # be gentle on the Anthropic API between confirm calls


def _normalize_dsn(raw: str) -> str:
    """Strip a SQLAlchemy driver suffix (postgresql+asyncpg://) → plain asyncpg DSN."""
    scheme, sep, rest = raw.partition("://")
    return f"{scheme.split('+', 1)[0]}{sep}{rest}" if sep else raw


async def _pending_conv_ids(pool: asyncpg.Pool, limit: int | None) -> list[int]:
    """Distinct conversations that still carry an un-acked merge_suggestion, newest
    suggestion first — the same population the cron pulls from, but ALL of it."""
    rows = await pool.fetch(
        """
        SELECT conversation_id, max(created_at) AS newest
        FROM alert
        WHERE type = 'merge_suggestion' AND acknowledged_at IS NULL
          AND conversation_id IS NOT NULL
        GROUP BY conversation_id
        ORDER BY newest DESC
        """
    )
    ids = [r["conversation_id"] for r in rows]
    return ids[:limit] if limit else ids


async def _open_redis(execute: bool):
    """A redis client for the per-conversation lock (only in --execute). Best-effort:
    if it can't be built, return None and rate_limit falls open (the FK catch in
    _send_and_persist still protects the in-flight reply)."""
    if not execute:
        return None
    url = os.environ.get("REDIS_URL")
    if not url:
        print("! REDIS_URL not set — merging WITHOUT the per-conv lock (fail-open)", file=sys.stderr)
        return None
    try:
        import redis.asyncio as aioredis
        client = aioredis.from_url(url)
        await client.ping()
        return client
    except Exception as exc:  # noqa: BLE001 — lock is best-effort, not required
        print(f"! could not open redis ({exc}) — merging WITHOUT the per-conv lock", file=sys.stderr)
        return None


async def _merge_locked(pool, redis, conv_id: int, sibling_id: int, result) -> bool:
    """Merge conv_id → sibling_id holding BOTH per-conv locks (same discipline as the
    cron: never delete a conversation an auto_reply job is mid-send on). Returns True
    on merge, False if either lock is held (busy → leave for a later pass)."""
    if not await rate_limit.acquire_conv_lock(redis, conv_id):
        return False
    try:
        if not await rate_limit.acquire_conv_lock(redis, sibling_id):
            return False
        try:
            await queries.merge_conversation_into(
                pool, conv_id, sibling_id, triggered_by="auto",
                confidence=result.confidence, reasoning=result.reasoning,
            )
            return True
        finally:
            await rate_limit.release_conv_lock(redis, sibling_id)
    finally:
        await rate_limit.release_conv_lock(redis, conv_id)


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--execute", action="store_true", help="actually merge (default: dry-run, no writes)")
    ap.add_argument("--limit", type=int, default=None, help="cap how many conversations to examine")
    ap.add_argument("--min-confidence", type=float, default=_DEFAULT_MIN_CONF, help="IA gate (default 0.85)")
    ap.add_argument("--verbose", action="store_true", help="print each per-conversation decision")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("ERROR: DATABASE_URL not set", file=sys.stderr)
        return 2

    mode = "EXECUTE" if args.execute else "DRY-RUN"
    pool = await asyncpg.create_pool(_normalize_dsn(dsn), min_size=1, max_size=2)
    redis = await _open_redis(args.execute)
    counts = {"merged": 0, "no_sibling": 0, "low_conf": 0, "busy": 0, "gone": 0, "error": 0}
    try:
        conv_ids = await _pending_conv_ids(pool, args.limit)
        total = len(conv_ids)
        print(f"[{mode}] examining {total} conversation(s) with pending merge suggestions "
              f"(IA gate >= {args.min_confidence:.2f})\n")

        for i, conv_id in enumerate(conv_ids, 1):
            try:
                # Gate 1 — deterministic structural sibling.
                sibling_id = await queries.find_structural_merge_sibling(pool, conv_id)
                if not sibling_id:
                    counts["no_sibling"] += 1
                    if args.verbose:
                        print(f"  conv {conv_id}: no clean structural sibling → leave")
                    continue
                # Gate 2 — IA confirms THAT pair at high confidence.
                result = await confirm_same_client(pool, conv_id, sibling_id)
                await asyncio.sleep(_IA_THROTTLE_S)
                if not result or result.best_match_id != sibling_id:
                    counts["gone"] += 1
                    if args.verbose:
                        print(f"  conv {conv_id}: IA did not confirm sibling {sibling_id} → leave")
                    continue
                if result.confidence < args.min_confidence:
                    counts["low_conf"] += 1
                    if args.verbose:
                        print(f"  conv {conv_id}: IA conf {result.confidence:.2f} < gate → leave")
                    continue

                if not args.execute:
                    counts["merged"] += 1  # "would merge"
                    if args.verbose:
                        print(f"  conv {conv_id} → {sibling_id}: WOULD merge (conf {result.confidence:.2f})")
                    continue

                did = await _merge_locked(pool, redis, conv_id, sibling_id, result)
                if did:
                    counts["merged"] += 1
                    print(f"  merged conv {conv_id} → {sibling_id} (conf {result.confidence:.2f})")
                else:
                    counts["busy"] += 1
                    if args.verbose:
                        print(f"  conv {conv_id}: lock held (reply in flight) → skip this pass")
            except ValueError as exc:
                counts["gone"] += 1  # stale/invalid pair (already merged, cross-casa, etc.)
                if args.verbose:
                    print(f"  conv {conv_id}: skipped ({exc})")
            except Exception:
                counts["error"] += 1
                logger.exception("backfill: failed for conv %s", conv_id)

            if i % 25 == 0:
                print(f"  … {i}/{total} examined "
                      f"({'merged' if args.execute else 'would merge'}={counts['merged']})")
    finally:
        await pool.close()
        if redis is not None:
            try:
                await redis.aclose()  # redis-py >= 4.6
            except AttributeError:
                await redis.close()   # older client

    verb = "MERGED" if args.execute else "WOULD MERGE"
    print(
        f"\n[{mode}] done.\n"
        f"  {verb:<12}: {counts['merged']}\n"
        f"  no sibling  : {counts['no_sibling']}\n"
        f"  low conf    : {counts['low_conf']}\n"
        f"  IA declined : {counts['gone']}\n"
        f"  busy (lock) : {counts['busy']}\n"
        f"  errors      : {counts['error']}"
    )
    if not args.execute and counts["merged"]:
        print(f"\nRe-run with --execute to actually merge those {counts['merged']}. "
              f"Every merge is reversible (merge_event snapshot).")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
