"""Tests for the WAHA webhook message handlers.

Covers the happy path + edge cases that would cause data loss in production:
  - incoming message creates contact + conversation + message
  - outgoing (fromMe=true) uses payload.to (not .from)
  - @lid and @g.us JIDs are dropped
  - idempotent on duplicate msg_id
  - ack updates existing message
  - session FAILED status raises alert
"""
from __future__ import annotations

from app.routes.webhooks import (
    _handle_message,
    _handle_message_ack,
    _handle_session_status,
)


class _FakeArq:
    """Stand-in for the ArqRedis handle: records enqueues, never hits Redis.

    `_handle_message` takes the arq handle as its 2nd arg to enqueue auto_reply_job;
    these handler tests only assert DB effects, so a no-op recorder suffices.
    """

    def __init__(self) -> None:
        self.jobs: list = []

    async def enqueue_job(self, *args, **kw):
        self.jobs.append((args, kw))


_ARQ = _FakeArq()


# ── Fixtures ──────────────────────────────────────────────────────

async def _seed_casa(pool, session: str = "default", name: str = "Test") -> int:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "INSERT INTO casa (name, waha_session) VALUES ($1, $2) RETURNING id",
            name, session,
        )
        return row["id"]


def _msg(**overrides):
    base = {
        "id": "msg-001",
        "from": "34600000001@c.us",
        "to": "34603201414@c.us",
        "fromMe": False,
        "timestamp": 1776867000,
        "body": "hola",
        "hasMedia": False,
    }
    base.update(overrides)
    return base


# ── Tests ─────────────────────────────────────────────────────────

async def test_incoming_creates_contact_conv_message(pg_pool):
    await _seed_casa(pg_pool)
    await _handle_message(pg_pool, _ARQ, "default",_msg(body="buenas"))

    async with pg_pool.acquire() as conn:
        c = await conn.fetchval("SELECT count(*) FROM contact")
        v = await conn.fetchval("SELECT count(*) FROM conversation")
        m = await conn.fetchval("SELECT count(*) FROM message WHERE direction='in'")
        jid = await conn.fetchval("SELECT waha_jid FROM contact")
        assert (c, v, m) == (1, 1, 1)
        assert jid == "34600000001@c.us"


async def test_outgoing_uses_to_field(pg_pool):
    """fromMe=true → chat_id should be payload.to, not payload.from."""
    await _seed_casa(pg_pool)
    await _handle_message(
        pg_pool, _ARQ, "default",
        _msg(id="out-1", fromMe=True, **{"from": "34603201414@c.us", "to": "34655555555@c.us"}),
    )
    async with pg_pool.acquire() as conn:
        jid = await conn.fetchval("SELECT waha_jid FROM contact")
        direction = await conn.fetchval("SELECT direction FROM message")
    assert jid == "34655555555@c.us"
    assert direction == "out"


async def test_lid_jid_is_dropped(pg_pool):
    await _seed_casa(pg_pool)
    await _handle_message(pg_pool, _ARQ, "default",_msg(**{"from": "261443685490905@lid"}))
    async with pg_pool.acquire() as conn:
        assert await conn.fetchval("SELECT count(*) FROM message") == 0


async def test_group_jid_is_dropped(pg_pool):
    await _seed_casa(pg_pool)
    await _handle_message(pg_pool, _ARQ, "default",_msg(**{"from": "120363001@g.us"}))
    async with pg_pool.acquire() as conn:
        assert await conn.fetchval("SELECT count(*) FROM message") == 0


async def test_idempotent_same_msg_id(pg_pool):
    await _seed_casa(pg_pool)
    payload = _msg(id="dedup-1")
    await _handle_message(pg_pool, _ARQ, "default",payload)
    await _handle_message(pg_pool, _ARQ, "default",payload)  # replay
    async with pg_pool.acquire() as conn:
        assert await conn.fetchval("SELECT count(*) FROM message") == 1


async def test_unread_incremented_for_incoming(pg_pool):
    await _seed_casa(pg_pool)
    await _handle_message(pg_pool, _ARQ, "default",_msg(id="a"))
    await _handle_message(pg_pool, _ARQ, "default",_msg(id="b"))
    async with pg_pool.acquire() as conn:
        unread = await conn.fetchval("SELECT unread_count FROM conversation")
    assert unread == 2


async def test_unread_not_incremented_for_outgoing(pg_pool):
    await _seed_casa(pg_pool)
    await _handle_message(pg_pool, _ARQ, "default",_msg(id="in-1"))
    await _handle_message(
        pg_pool, _ARQ, "default",
        _msg(id="out-1", fromMe=True,
             **{"from": "34603201414@c.us", "to": "34600000001@c.us"}),
    )
    async with pg_pool.acquire() as conn:
        unread = await conn.fetchval("SELECT unread_count FROM conversation")
    assert unread == 1  # only the incoming one bumped it


async def test_ack_updates_existing_message(pg_pool):
    await _seed_casa(pg_pool)
    await _handle_message(pg_pool, _ARQ, "default",_msg(id="ack-1", ack=1))
    await _handle_message_ack(pg_pool, {"id": "ack-1", "ack": 4})
    async with pg_pool.acquire() as conn:
        ack = await conn.fetchval("SELECT ack FROM message WHERE waha_msg_id='ack-1'")
    assert ack == 4


async def test_session_failed_creates_alert(pg_pool):
    await _handle_session_status(pg_pool, "default", {"status": "FAILED"})
    async with pg_pool.acquire() as conn:
        n = await conn.fetchval("SELECT count(*) FROM alert WHERE type='wa_disconnected'")
    assert n == 1


async def test_session_working_no_alert(pg_pool):
    await _handle_session_status(pg_pool, "default", {"status": "WORKING"})
    async with pg_pool.acquire() as conn:
        n = await conn.fetchval("SELECT count(*) FROM alert")
    assert n == 0


async def test_missing_id_or_chat_id_is_skipped(pg_pool):
    await _seed_casa(pg_pool)
    await _handle_message(pg_pool, _ARQ, "default",{"id": "x"})  # no from/to
    await _handle_message(pg_pool, _ARQ, "default",{"from": "34600000001@c.us"})  # no id
    async with pg_pool.acquire() as conn:
        assert await conn.fetchval("SELECT count(*) FROM message") == 0


async def test_auto_creates_casa_if_session_unknown(pg_pool):
    """Safety net: message arrives for unmapped session → creates casa."""
    await _handle_message(pg_pool, _ARQ, "unmapped-session", _msg())
    async with pg_pool.acquire() as conn:
        casa_count = await conn.fetchval("SELECT count(*) FROM casa WHERE waha_session='unmapped-session'")
    assert casa_count == 1
