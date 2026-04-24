"""Pytest fixtures — in-memory SQLite via asyncpg-compatible shim.

We spin up a temporary Postgres via `testing.postgresql` if available,
else tests requiring DB are skipped. For the webhook tests we use a
real asyncpg pool pointing to a disposable DB schema.

Run locally with a running Postgres (e.g. via docker-compose postgres),
setting TEST_DATABASE_URL. In CI, spin up postgres:16-alpine.
"""
from __future__ import annotations

import os
from collections.abc import AsyncIterator

import asyncpg
import pytest


TEST_DB_URL = os.environ.get("TEST_DATABASE_URL")


@pytest.fixture
async def pg_pool() -> AsyncIterator[asyncpg.Pool]:
    """Real Postgres pool. Skips tests if TEST_DATABASE_URL not set."""
    if not TEST_DB_URL:
        pytest.skip("TEST_DATABASE_URL not set — skipping DB-backed tests")

    pool = await asyncpg.create_pool(dsn=TEST_DB_URL, min_size=1, max_size=3)
    assert pool is not None

    # Fresh schema per test
    async with pool.acquire() as conn:
        await conn.execute(
            """
            DROP TABLE IF EXISTS message, conversation, contact, casa,
                                  analysis, alert, admin_user, casa_meta_analysis CASCADE;
            """
        )
        # Minimal schema (subset of migrations 0001–0003 used by webhook)
        await conn.execute("""
            CREATE TABLE casa (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                waha_session TEXT UNIQUE NOT NULL,
                created_at TIMESTAMPTZ DEFAULT now()
            );
            CREATE TABLE contact (
                id BIGSERIAL PRIMARY KEY,
                waha_jid TEXT UNIQUE NOT NULL,
                name TEXT, phone TEXT,
                created_at TIMESTAMPTZ DEFAULT now()
            );
            CREATE TABLE conversation (
                id BIGSERIAL PRIMARY KEY,
                casa_id INT REFERENCES casa(id) ON DELETE CASCADE,
                contact_id BIGINT REFERENCES contact(id),
                status TEXT DEFAULT 'open',
                last_message_at TIMESTAMPTZ,
                unread_count INT DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT now(),
                updated_at TIMESTAMPTZ DEFAULT now(),
                UNIQUE (casa_id, contact_id)
            );
            CREATE TABLE message (
                id BIGSERIAL PRIMARY KEY,
                conversation_id BIGINT REFERENCES conversation(id) ON DELETE CASCADE,
                waha_msg_id TEXT UNIQUE,
                direction TEXT NOT NULL,
                body TEXT,
                media_url TEXT, media_mime TEXT,
                ack SMALLINT DEFAULT 0,
                created_at TIMESTAMPTZ NOT NULL
            );
            CREATE TABLE alert (
                id BIGSERIAL PRIMARY KEY,
                type TEXT, severity TEXT,
                conversation_id BIGINT, inbox_id INT,
                message TEXT, created_at TIMESTAMPTZ DEFAULT now(),
                acknowledged_at TIMESTAMPTZ
            );
        """)

    try:
        yield pool
    finally:
        await pool.close()
