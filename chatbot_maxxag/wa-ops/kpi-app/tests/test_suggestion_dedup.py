"""Tests for the copilot agent_suggestion dedup + ack-all contract (FIX 1).

Two layers, mirroring the existing test style:

  - PURE: the command-tag row-count parsing in supersede_pending_suggestions is
    exercised with a tiny fake asyncpg-like pool (no DB), like the _FakePool used
    in test_auto_reply.py. This guards the "returns rows superseded" contract.

  - DB-BACKED: the real dedup contract (at most ONE pending suggestion per
    conversation, and ack-all clears them) runs against Postgres via the shared
    `pg_pool` fixture, which auto-skips when TEST_DATABASE_URL is unset (same
    skip pattern as test_webhook_handlers.py). No DB is invented.
"""
from __future__ import annotations

import pytest

from app import queries


# ── PURE: command-tag row-count parsing (no DB) ──────────────────────
class _TagConn:
    """Fake asyncpg conn whose execute() returns a canned command tag."""

    def __init__(self, tag: str) -> None:
        self._tag = tag

    async def execute(self, _sql, *_args):
        return self._tag


class _TagAcquire:
    def __init__(self, conn):
        self._conn = conn

    async def __aenter__(self):
        return self._conn

    async def __aexit__(self, *exc):
        return False


class _TagPool:
    def __init__(self, tag: str) -> None:
        self._conn = _TagConn(tag)

    def acquire(self):
        return _TagAcquire(self._conn)


@pytest.mark.parametrize(
    ("tag", "expected"),
    [("UPDATE 0", 0), ("UPDATE 1", 1), ("UPDATE 3", 3)],
)
async def test_supersede_returns_affected_row_count(tag, expected):
    """The helper parses the 'UPDATE N' command tag into the affected-row count."""
    pool = _TagPool(tag)
    assert await queries.supersede_pending_suggestions(pool, 1) == expected


async def test_supersede_non_update_tag_is_zero():
    """A non-UPDATE tag (defensive) yields 0 rather than raising."""
    pool = _TagPool("SELECT 0")
    assert await queries.supersede_pending_suggestions(pool, 1) == 0


async def test_ack_all_delegates_to_supersede():
    """ack_all_suggestions shares the same SQL/contract as supersede."""
    pool = _TagPool("UPDATE 2")
    assert await queries.ack_all_suggestions(pool, 1) == 2


# ── DB-BACKED: dedup + ack-all contract (skips without TEST_DATABASE_URL) ──
async def _seed_conv(pool) -> int:
    """Minimal casa + contact + conversation, returns the conversation id.

    Uses only the disposable schema created by the pg_pool fixture."""
    async with pool.acquire() as conn:
        casa_id = await conn.fetchval(
            "INSERT INTO casa (name, waha_session) VALUES ($1, $2) RETURNING id",
            "Test", "sess",
        )
        contact_id = await conn.fetchval(
            "INSERT INTO contact (waha_jid, name) VALUES ($1, $2) RETURNING id",
            "34600000001@c.us", "Juan",
        )
        return await conn.fetchval(
            """
            INSERT INTO conversation (casa_id, contact_id, last_message_at)
            VALUES ($1, $2, now()) RETURNING id
            """,
            casa_id, contact_id,
        )


async def _pending_count(pool, conv_id: int) -> int:
    async with pool.acquire() as conn:
        return await conn.fetchval(
            """
            SELECT count(*) FROM alert
            WHERE conversation_id = $1 AND type = 'agent_suggestion'
              AND acknowledged_at IS NULL
            """,
            conv_id,
        )


async def test_dedup_keeps_one_pending_suggestion(pg_pool):
    """Storing N suggestions with supersede-before-insert leaves exactly ONE
    pending (the auto_reply copilot-branch contract)."""
    conv_id = await _seed_conv(pg_pool)

    for i in range(3):
        # Mirror auto_reply.py copilot branch: supersede prior, then insert new.
        await queries.supersede_pending_suggestions(pg_pool, conv_id)
        await queries.insert_alert(
            pg_pool,
            type="agent_suggestion",
            severity="info",
            conversation_id=conv_id,
            inbox_id=None,
            message=f"draft {i}",
        )

    assert await _pending_count(pg_pool, conv_id) == 1


async def test_ack_all_clears_every_pending_suggestion(pg_pool):
    """Even if multiple unacked suggestions exist (legacy/race), ack-all clears
    them all so the Sara badge fully clears."""
    conv_id = await _seed_conv(pg_pool)

    # Insert 3 WITHOUT superseding to simulate stacked legacy rows.
    for i in range(3):
        await queries.insert_alert(
            pg_pool,
            type="agent_suggestion",
            severity="info",
            conversation_id=conv_id,
            inbox_id=None,
            message=f"draft {i}",
        )
    assert await _pending_count(pg_pool, conv_id) == 3

    acked = await queries.ack_all_suggestions(pg_pool, conv_id)
    assert acked == 3
    assert await _pending_count(pg_pool, conv_id) == 0
