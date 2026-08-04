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
                                  analysis, alert, admin_user, user_casa, audit_log,
                                  merge_event, casa_meta_analysis CASCADE;
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
                wa_number_id INT,
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
                agent_generated BOOLEAN DEFAULT FALSE,
                sent_by_user_id INT,
                merged_from_conv_id BIGINT,
                created_at TIMESTAMPTZ NOT NULL
            );
            CREATE TABLE alert (
                id BIGSERIAL PRIMARY KEY,
                type TEXT, severity TEXT,
                conversation_id BIGINT, inbox_id INT,
                message TEXT, created_at TIMESTAMPTZ DEFAULT now(),
                acknowledged_at TIMESTAMPTZ
            );
            -- RBAC tables (migration 0018)
            CREATE TABLE admin_user (
                id SERIAL PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                name TEXT,
                role TEXT NOT NULL DEFAULT 'agent',
                active BOOLEAN NOT NULL DEFAULT TRUE,
                created_at TIMESTAMPTZ DEFAULT now(),
                last_login_at TIMESTAMPTZ
            );
            CREATE TABLE user_casa (
                user_id INT REFERENCES admin_user(id) ON DELETE CASCADE,
                casa_id INT REFERENCES casa(id) ON DELETE CASCADE,
                PRIMARY KEY (user_id, casa_id)
            );
            CREATE TABLE audit_log (
                id BIGSERIAL PRIMARY KEY,
                at TIMESTAMPTZ NOT NULL DEFAULT now(),
                user_id INT REFERENCES admin_user(id) ON DELETE SET NULL,
                actor_label TEXT NOT NULL,
                action TEXT NOT NULL,
                entity_type TEXT,
                entity_id BIGINT,
                meta JSONB
            );
            -- Analysis + undo infra (subset of migrations 0001 / 0009)
            CREATE TABLE analysis (
                id BIGSERIAL PRIMARY KEY,
                conversation_id BIGINT UNIQUE NOT NULL,
                account_id INT,
                analyzed_at TIMESTAMPTZ DEFAULT now()
            );
            CREATE TABLE merge_event (
                id BIGSERIAL PRIMARY KEY,
                target_conv_id BIGINT,
                source_conv_id BIGINT NOT NULL,
                source_casa_id INT,
                source_wa_number_id INT,
                source_contact_id BIGINT,
                source_contact_snapshot JSONB NOT NULL,
                source_status TEXT,
                source_unread_count INT NOT NULL DEFAULT 0,
                messages_moved INT NOT NULL DEFAULT 0,
                triggered_by TEXT NOT NULL,
                confidence DOUBLE PRECISION,
                reasoning TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                undone_at TIMESTAMPTZ
            );
        """)

    try:
        yield pool
    finally:
        await pool.close()
